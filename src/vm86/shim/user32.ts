import type { Win32Call, Win32Result } from '../win32';
import { HYPERCALL_CURSOR_COUNT } from '../pe';
import { defaultMessageBoxResult } from './text';
import { withGdi32 } from './gdi32';
import { withUser32Windowing } from './user32Windowing';
import { withUser32MessageLoop } from './user32MessageLoop';
import { GUEST_PROCESS_ID, shimTraceEnabled } from './state';
import type { Constructor } from './state';
import { keyNameText, mapVirtualKey, toAscii } from './keyboard';

type Gdi32Chain = InstanceType<ReturnType<typeof withGdi32>>;

/** The host implements built-in window-class default procedures; expose nonzero guest tokens to preserve subclass-chain semantics. */
const HOST_DEFAULT_WNDPROC = 0xffff_0001;
const HOST_DEFAULT_CLASSES = new Set([
  '#32770',
  'button',
  'combobox',
  'combodropwin',
  'edit',
  'listbox',
  'scrollbar',
  'static',
  'msctls_trackbar32',
]);

/** User32 Win32 API cases extracted from Win32Shim.dispatch's main switch. */
export function withUser32<TBase extends Constructor<Gdi32Chain>>(Base: TBase) {
  const Windowing = withUser32Windowing(Base);
  const MessageLoop = withUser32MessageLoop(Windowing);
  return class extends MessageLoop {
    constructor(...args: any[]) {
      super(...args);
    }

    dispatchUser32(call: Win32Call, key: string, name: string, a: number[]): Win32Result | null {
      this.flushPendingPaintValidations();
      switch (key) {
        case 'USER32.DLL!MapVirtualKeyA':
          return { eax: mapVirtualKey(a[0] ?? 0, a[1] ?? 0) };
        case 'USER32.DLL!GetKeyNameTextA': {
          const destination = a[1] ?? 0;
          const capacity = a[2] ?? 0;
          if (!destination || capacity <= 0) return { eax: 0 };
          const name = keyNameText(a[0] ?? 0);
          const written = name.slice(0, capacity - 1);
          this.writeAscii(destination, written);
          return { eax: written.length };
        }
        case 'USER32.DLL!ToAscii': {
          if (!a[3]) return { eax: 0 };
          const state = a[2] ? this.memory.read_memory(a[2], 256) : new Uint8Array(256);
          const chars = toAscii(a[0] ?? 0, a[1] ?? 0, state);
          // LPWORD receives one or two bytes, not a DWORD based on character count; preserve the buffer when no character exists.
          if (chars.length) this.memory.write_memory([chars[0]!, chars[1] ?? 0], a[3]);
          return { eax: chars.length };
        }
        case 'USER32.DLL!LoadIconA':
          return { eax: 0x2001 };
        case 'USER32.DLL!LoadCursorA': {
          // Load and decode real cursor resources, presenting them as independent textures visible under Pointer Lock.
          // Handle only integer resource IDs; string names/system cursors fall back to fixed synthetic handles.
          const hInstance = a[0] ?? 0;
          const idOrPtr = a[1] ?? 0;
          if (idOrPtr > 0 && idOrPtr <= 0xffff) return { eax: this.loadCursorImage(hInstance, idOrPtr) };
          return { eax: 0x2002 };
        }
        case 'USER32.DLL!RegisterClassA':
          if (a[0]) {
            const className = this.readCString(this.readU32(a[0] + 36));
            if (className) {
              const normalized = className.toLowerCase();
              this.windowClasses.set(normalized, this.readU32(a[0] + 4));
              this.windowClassStyles.set(normalized, this.readU32(a[0]));
            }
            // Capture class hCursor at offset 24 for rendering; RA2 menus use it without SetCursor.
            const classCursor = this.readU32(a[0] + 24);
            if (classCursor) this.classCursor = classCursor;
          }
          return { eax: 1 };
        case 'USER32.DLL!UnregisterClassA':
          return { eax: 1 };
        case 'USER32.DLL!DestroyWindow':
          this.destroyWindow(call, a[0] ?? 0);
          return { eax: 1 };
        case 'USER32.DLL!ShowWindow': {
          const hwnd = a[0] ?? 0;
          if (!this.windows.has(hwnd)) return { eax: 0 };
          const key = `${hwnd}:-16`;
          const style = this.windowLongs.get(key) ?? 0;
          // Return the window's previous WS_VISIBLE bit without checking parents; callers use it
          // to decide whether to restore temporarily hidden children even while their parent is hidden.
          const wasVisible = (style & 0x10000000) !== 0;
          const showing = (a[1] ?? 0) !== 0; // SW_HIDE=0; all other commands show the window.
          if (shimTraceEnabled('VM_TRACE_WVIS') && wasVisible !== showing) {
            console.log(
              `👁️ ShowWindow hwnd=0x${hwnd.toString(16)} parent=0x${(this.windowParents.get(hwnd) ?? 0).toString(16)} cls=${this.windowClassNames.get(hwnd)} id=${this.controlIds.get(hwnd)} cmd=${a[1]} -> ${showing ? 'SHOW' : 'HIDE'}`,
            );
          }
          this.windowLongs.set(key, (showing ? style | 0x10000000 : style & ~0x10000000) >>> 0);
          if (showing) this.placeWindow(hwnd, 0);
          this.syncWindowToGuest(hwnd);
          const shellPage = this.shellPageSyncTarget(hwnd);
          if (shellPage) this.synchronizeShellPage(shellPage !== hwnd);
          if (!showing) {
            // After hiding the subtree containing focus, return keyboard input to the top-level window.
            // RA2 hides some shell pages instead of immediately destroying them on battlefield entry;
            // sending WM_KEYDOWN to hidden controls would prevent native input management from receiving Ctrl and other keys.
            this.hideWindowState(hwnd);
          } else {
            // When a parent reappears, upper shell pages may have overwritten child pixels previously drawn into primary.
            // Win32 repaints exposed children too; redrawing only the parent border is insufficient.
            this.invalidateWindowTree(hwnd);
          }
          if (wasVisible === showing) return { eax: wasVisible ? 1 : 0 };
          if (this.windows.get(hwnd)) {
            return this.sendMessage(call, [hwnd, 0x0018, showing ? 1 : 0, 0], wasVisible ? 1 : 0);
          }
          return { eax: wasVisible ? 1 : 0 };
        }
        case 'USER32.DLL!UpdateWindow': {
          const hwnd = a[0] ?? 0;
          if (!this.invalidatedWindows.has(hwnd)) return { eax: 1 };
          return this.paintWindow(call, hwnd);
        }
        case 'USER32.DLL!AdjustWindowRectEx':
        case 'USER32.DLL!AdjustWindowRect':
          return { eax: 1 };
        case 'USER32.DLL!BringWindowToTop':
          {
            const hwnd = a[0] ?? 0;
            if (!this.windows.has(hwnd)) return { eax: 0 };
            this.placeWindow(hwnd, 0);
            const shellPage = this.shellPageSyncTarget(hwnd);
            if (shellPage) this.synchronizeShellPage(shellPage !== hwnd);
          }
          return { eax: 1 };
        case 'USER32.DLL!EnableWindow': {
          const hwnd = a[0] ?? 0;
          if (!this.windows.has(hwnd)) return { eax: 0 };
          const key = `${hwnd}:-16`;
          const style = this.windowLongs.get(key) ?? 0;
          const wasDisabled = (style & 0x08000000) !== 0;
          const enabled = (a[1] ?? 0) !== 0;
          if (wasDisabled === !enabled) return { eax: wasDisabled ? 1 : 0 };
          this.windowLongs.set(key, (enabled ? style & ~0x08000000 : style | 0x08000000) >>> 0);
          this.syncWindowToGuest(hwnd);
          if (!enabled) {
            if (this.isWindowInTree(this.captureWindow, hwnd)) this.captureWindow = 0;
            if (this.isWindowInTree(this.focusWindow, hwnd)) this.focusWindow = 0;
          }
          if (this.isWindowVisible(hwnd)) this.invalidateWindow(hwnd);
          // When disabling a window, Win32 synchronously sends WM_CANCELMODE before WM_ENABLE; the former closes active drags/
          // popups, while the latter updates owner-drawn control interaction/rendering state.
          // EnableWindow still returns the prior disabled state, not WndProc's result.
          const messages = enabled
            ? [{ message: 0x000a, wParam: 1, lParam: 0 }]
            : [
                { message: 0x001f, wParam: 0, lParam: 0 },
                { message: 0x000a, wParam: 0, lParam: 0 },
              ];
          return this.sendMessageSequence(call, hwnd, messages, wasDisabled ? 1 : 0);
        }
        case 'USER32.DLL!SetWindowTextA': {
          const hwnd = a[0] ?? 0;
          const text = a[1] ? this.readCString(a[1]) : '';
          this.windowTexts.set(hwnd, text);
          const shellPage = this.shellPageSyncTarget(hwnd);
          const titleControlId = this.gameProfile.shell?.titleControlId;
          if (
            shellPage &&
            titleControlId !== undefined &&
            this.controlIds.get(hwnd) === titleControlId &&
            shellPage === this.activeShellPage &&
            this.isWindowTreeVisible(hwnd)
          )
            this.shellPageTitle = text;
          this.invalidateWindow(hwnd);
          return { eax: 1 };
        }
        case 'USER32.DLL!GetWindowTextA':
          return { eax: this.copyWindowText(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) };
        case 'USER32.DLL!SetDlgItemTextA': {
          const child = this.dialogChildren.get(`${a[0] ?? 0}:${a[1] ?? 0}`) ?? 0;
          if (!child) return { eax: 0 };
          const text = a[2] ? this.readCString(a[2]) : '';
          this.windowTexts.set(child, text);
          const shellPage = this.shellPageSyncTarget(child);
          const titleControlId = this.gameProfile.shell?.titleControlId;
          if (
            shellPage &&
            titleControlId !== undefined &&
            this.controlIds.get(child) === titleControlId &&
            shellPage === this.activeShellPage &&
            this.isWindowTreeVisible(child)
          )
            this.shellPageTitle = text;
          this.invalidateWindow(child);
          return { eax: 1 };
        }
        case 'USER32.DLL!GetDlgItemTextA': {
          const child = this.dialogChildren.get(`${a[0] ?? 0}:${a[1] ?? 0}`) ?? 0;
          return { eax: this.copyWindowText(child, a[2] ?? 0, a[3] ?? 0) };
        }
        case 'USER32.DLL!SetWindowPos': {
          const hwnd = a[0] ?? 0;
          const current = this.windowRects.get(hwnd) ?? { x: 0, y: 0, width: 0, height: 0 };
          const flags = a[6] ?? 0;
          const showWindow = (flags & 0x0040) !== 0; // SWP_SHOWWINDOW
          const hideWindow = (flags & 0x0080) !== 0; // SWP_HIDEWINDOW
          const styleKey = `${hwnd}:-16`;
          const previousStyle = this.windowLongs.get(styleKey) ?? 0;
          const nextStyle =
            showWindow && !hideWindow
              ? previousStyle | 0x1000_0000
              : hideWindow && !showWindow
                ? previousStyle & ~0x1000_0000
                : previousStyle;
          const visibilityChanged = nextStyle !== previousStyle;
          const next = {
            x: (flags & 0x0002) !== 0 ? current.x : a[2] | 0, // SWP_NOMOVE
            y: (flags & 0x0002) !== 0 ? current.y : a[3] | 0,
            width: (flags & 0x0001) !== 0 ? current.width : Math.max(0, a[4] | 0), // SWP_NOSIZE
            height: (flags & 0x0001) !== 0 ? current.height : Math.max(0, a[5] | 0),
          };
          if ((flags & 0x0001) === 0) next.height = this.resizeComboHeight(hwnd, next.height);
          if (visibilityChanged) this.windowLongs.set(styleKey, nextStyle >>> 0);
          this.windowRects.set(hwnd, next);
          const zOrderChanged = (flags & 0x0004) === 0;
          if (zOrderChanged) this.placeWindow(hwnd, a[1] ?? 0); // SWP_NOZORDER
          this.syncWindowTreeToGuest(hwnd);
          const shellPage = this.shellPageSyncTarget(hwnd);
          if (shellPage && (visibilityChanged || zOrderChanged)) {
            this.synchronizeShellPage(shellPage !== hwnd);
          }
          const redraw = (flags & 0x0008) === 0; // SWP_NOREDRAW
          if (hideWindow && !showWindow) {
            this.hideWindowState(hwnd, redraw);
          } else if (showWindow && !hideWindow) {
            if (redraw) this.invalidateWindowTree(hwnd);
          } else if (redraw) {
            this.invalidateWindow(hwnd);
          }
          return { eax: 1 };
        }
        case 'USER32.DLL!MoveWindow': {
          const hwnd = a[0] ?? 0;
          const next = {
            x: a[1] | 0,
            y: a[2] | 0,
            width: Math.max(0, a[3] | 0),
            height: Math.max(0, a[4] | 0),
          };
          next.height = this.resizeComboHeight(hwnd, next.height);
          this.windowRects.set(hwnd, next);
          this.syncWindowTreeToGuest(hwnd);
          return a[5] ? this.paintWindow(call, hwnd) : { eax: 1 };
        }
        case 'USER32.DLL!InvalidateRect':
        case 'USER32.DLL!RedrawWindow':
          if (shimTraceEnabled('VM_TRACE_GADGET')) {
            const target = a[0] ?? 0;
            console.log(
              `🩹 InvalidateRect hwnd=0x${target.toString(16)} cls=${this.windowClassNames.get(target) ?? '?'} known=${this.windows.has(target)} proc=0x${(this.windows.get(target) ?? 0).toString(16)} visible=${this.isWindowVisible(target)} alreadyInvalid=${this.invalidatedWindows.has(target)} rect=${JSON.stringify(this.windowRects.get(target))} parent=0x${(this.windowParents.get(target) ?? 0).toString(16)}`,
            );
          }
          this.invalidateWindow(a[0] ?? 0);
          return { eax: 1 };
        case 'USER32.DLL!ValidateRect':
          this.validateWindow(a[0] ?? 0);
          return { eax: 1 };
        case 'USER32.DLL!SystemParametersInfoA':
          // SPI_GETWORKAREA lets the game center its 800x600 window.
          if ((a[0] ?? 0) === 0x30 && a[2]) {
            this.writeRect(a[2], 0, 0, this.displayWidth, this.displayHeight);
          }
          return { eax: 1 };
        case 'USER32.DLL!CreateWindowExA': {
          const hwnd = this.createWindow(call);
          if (
            shimTraceEnabled('VM_TRACE_GADGET') &&
            this.windowClassNames.get(hwnd)?.toLowerCase() === 'combodropwin'
          ) {
            const rect = this.windowRects.get(hwnd);
            console.log(
              `🧭 ComboDropWin hwnd=0x${hwnd.toString(16)} parent=0x${(this.windowParents.get(hwnd) ?? 0).toString(16)} rect=${rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '-'}`,
            );
          }
          // Registered game windows initialize native state during WM_CREATE.
          // The main window constructs its tooltip manager; ComboDropWin reads
          // its owner from CREATESTRUCT.lpCreateParams before CB_GETITEMHEIGHT.
          if (
            ((!(a[8] ?? 0) &&
              (this.gameProfile.shell?.topLevelCreateClassNames?.includes(this.windowClassNames.get(hwnd) ?? '') ??
                false)) ||
              (this.gameProfile.shell?.initializeComboDropWindow &&
                this.windowClassNames.get(hwnd)?.toLowerCase() === 'combodropwin')) &&
            (this.windows.get(hwnd) ?? 0)
          ) {
            return this.beginCustomWindowCreation(call, hwnd, a);
          }
          return { eax: hwnd };
        }
        case 'USER32.DLL!CreateDialogIndirectParamA': {
          // Modeless dialogs created by CreateDialogIndirectParam are HWNDs too.
          // RA2 parses main-menu controls itself and initializes them through later message pumping;
          // retain the dialog procedure so DispatchMessageA can enter the native dialog proc.
          const hwnd = this.allocateWindowHandle();
          const callback = a[3] ?? 0;
          this.windows.set(hwnd, callback);
          this.placeWindow(hwnd, 0);
          this.windowLongs.set(`${hwnd}:4`, callback); // DWLP_DLGPROC
          this.windowClassNames.set(hwnd, '#32770');
          this.windowParents.set(hwnd, a[2] ?? 0);
          this.createDialogRect(a[1] ?? 0, hwnd);
          this.createDialogChildren(a[1] ?? 0, hwnd);
          if (callback) this.beginDialogInitialization(call, hwnd, callback, a[4] ?? 0);
          return { eax: hwnd };
        }
        case 'USER32.DLL!CreateDialogParamA': {
          const resource = this.findPeResource(a[0] ?? 0, a[1] ?? 0, 5); // RT_DIALOG
          if (!resource) return { eax: 0 };
          this.loadedResources.set(resource.handle, resource);
          const hwnd = this.allocateWindowHandle();
          const callback = a[3] ?? 0;
          this.windows.set(hwnd, callback);
          this.placeWindow(hwnd, 0);
          this.windowLongs.set(`${hwnd}:4`, callback); // DWLP_DLGPROC
          this.windowClassNames.set(hwnd, '#32770');
          this.windowParents.set(hwnd, a[2] ?? 0);
          this.createDialogRect(resource.data, hwnd);
          this.createDialogChildren(resource.data, hwnd);
          if (callback) this.beginDialogInitialization(call, hwnd, callback, a[4] ?? 0);
          return { eax: hwnd };
        }
        case 'USER32.DLL!GetDlgItem': {
          const parent = a[0] ?? 0;
          const id = a[1] ?? 0;
          // Win32 searches existing immediate children only; missing controls return NULL and never create HWNDs implicitly.
          return { eax: this.dialogChildren.get(`${parent}:${id}`) ?? 0 };
        }
        case 'USER32.DLL!GetNextDlgTabItem': {
          const dialog = a[0] ?? 0,
            current = a[1] ?? 0;
          if (!this.windows.has(dialog) || !current) return { eax: 0 };
          const order: number[] = [],
            seen = new Set<number>();
          const visit = (parent: number) => {
            if (seen.has(parent)) return;
            seen.add(parent);
            // Template/creation order is independent of Z-order changes from BringWindowToTop during drawing.
            for (const [child, owner] of this.windowParents) {
              if (owner !== parent || !this.windows.has(child)) continue;
              order.push(child);
              if (((this.windowLongs.get(`${child}:-20`) ?? 0) & 0x10000) !== 0) visit(child);
            }
          };
          visit(dialog);
          const start = order.indexOf(current);
          if (start < 0) return { eax: 0 };
          for (let offset = 1; offset <= order.length; offset++) {
            const index = (start + (a[2] ? -offset : offset) + order.length) % order.length;
            const candidate = order[index]!;
            if (
              ((this.windowLongs.get(`${candidate}:-16`) ?? 0) & 0x10000) !== 0 &&
              this.isWindowTreeVisible(candidate) &&
              this.isWindowTreeEnabled(candidate)
            )
              return { eax: candidate };
          }
          return { eax: current };
        }
        case 'USER32.DLL!GetDlgCtrlID':
          return { eax: this.controlIds.get(a[0] ?? 0) ?? 0 };
        case 'USER32.DLL!GetParent':
          return { eax: this.windowParents.get(a[0] ?? 0) ?? 0 };
        case 'USER32.DLL!GetClassNameA': {
          const className = this.windowClassNames.get(a[0] ?? 0) ?? '';
          const capacity = a[2] ?? 0;
          if (!a[1] || capacity <= 0) return { eax: 0 };
          const written = Math.min(className.length, capacity - 1);
          this.writeAscii(a[1], className.slice(0, written));
          return { eax: written };
        }
        case 'USER32.DLL!EnumChildWindows':
          return { eax: this.beginEnumChildWindows(call, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) ? 1 : 0 };
        case 'USER32.DLL!GetDC':
          if (a[0]) {
            const origin = this.screenOrigin(a[0]);
            return { eax: this.createGdiDc(this.primarySurface, origin.x, origin.y) };
          }
          return { eax: this.createGdiDc(0) };
        case 'USER32.DLL!BeginPaint': {
          const hwnd = a[0] ?? 0;
          const origin = this.screenOrigin(hwnd);
          const rect = this.windowRects.get(hwnd);
          const dc = this.createGdiDc(hwnd ? this.primarySurface : 0, origin.x, origin.y);
          const paint = a[1] ?? 0;
          if (paint) {
            this.zero(paint, 64);
            this.writeU32(paint, dc);
            this.writeRect(paint + 8, 0, 0, rect?.width ?? this.displayWidth, rect?.height ?? this.displayHeight);
          }
          this.validateWindow(hwnd);
          return { eax: dc };
        }
        case 'USER32.DLL!ReleaseDC':
          return { eax: this.releaseGdiDc(a[1] ?? 0) ? 1 : 0 };
        case 'USER32.DLL!EndPaint': {
          const paint = a[1] ?? 0;
          this.invalidatedWindows.delete(a[0] ?? 0);
          return { eax: !paint || this.releaseGdiDc(this.readU32(paint)) ? 1 : 0 };
        }
        case 'USER32.DLL!GetClientRect': {
          const rect = this.windowRects.get(a[0] ?? 0);
          if (a[1]) this.writeRect(a[1], 0, 0, rect?.width ?? this.displayWidth, rect?.height ?? this.displayHeight);
          return { eax: 1 };
        }
        case 'USER32.DLL!GetWindowRect': {
          const rect = this.screenRect(a[0] ?? 0);
          if (a[1]) this.writeRect(a[1], rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
          return { eax: 1 };
        }
        case 'USER32.DLL!OffsetRect': {
          const rectangle = a[0] ?? 0;
          if (!rectangle) return { eax: 0 };
          for (let index = 0; index < 4; index++) {
            const offset = (a[1 + (index % 2)] ?? 0) | 0;
            this.writeU32(rectangle + index * 4, this.readU32(rectangle + index * 4) + offset);
          }
          return { eax: 1 };
        }
        case 'USER32.DLL!SetRect':
          if (a[0]) this.writeRect(a[0], a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0);
          return { eax: 1 };
        case 'USER32.DLL!IntersectRect': {
          const destination = a[0] ?? 0;
          const first = a[1] ?? 0;
          const second = a[2] ?? 0;
          if (!destination || !first || !second) return { eax: 0 };
          const left = Math.max(this.readU32(first) | 0, this.readU32(second) | 0);
          const top = Math.max(this.readU32(first + 4) | 0, this.readU32(second + 4) | 0);
          const right = Math.min(this.readU32(first + 8) | 0, this.readU32(second + 8) | 0);
          const bottom = Math.min(this.readU32(first + 12) | 0, this.readU32(second + 12) | 0);
          if (right <= left || bottom <= top) {
            this.writeRect(destination, 0, 0, 0, 0);
            return { eax: 0 };
          }
          this.writeRect(destination, left, top, right, bottom);
          return { eax: 1 };
        }
        case 'USER32.DLL!GetCursorPos':
          if (a[0]) {
            this.writeU32(a[0], this.cursorX);
            this.writeU32(a[0] + 4, this.cursorY);
          }
          if (shimTraceEnabled('VM_TRACE_INPUTAPI'))
            console.log(
              `🎯 GetCursorPos -> ${this.cursorX},${this.cursorY} from=0x${this.readU32(call.stack).toString(16)}`,
            );
          return { eax: 1 };
        case 'USER32.DLL!ClientToScreen': {
          const origin = this.screenOrigin(a[0] ?? 0);
          if (a[1]) {
            this.writeU32(a[1], (this.readU32(a[1]) + origin.x) >>> 0);
            this.writeU32(a[1] + 4, (this.readU32(a[1] + 4) + origin.y) >>> 0);
          }
          return { eax: 1 };
        }
        case 'USER32.DLL!ScreenToClient': {
          const origin = this.screenOrigin(a[0] ?? 0);
          if (shimTraceEnabled('VM_TRACE_INPUTAPI'))
            console.log(
              `🎯 ScreenToClient hwnd=0x${(a[0] ?? 0).toString(16)} origin=${origin.x},${origin.y} in=${a[1] ? `${this.readU32(a[1])},${this.readU32(a[1] + 4)}` : '-'}`,
            );
          if (a[1]) {
            this.writeU32(a[1], (this.readU32(a[1]) - origin.x) >>> 0);
            this.writeU32(a[1] + 4, (this.readU32(a[1] + 4) - origin.y) >>> 0);
          }
          return { eax: 1 };
        }
        case 'USER32.DLL!SetCursorPos':
          this.cursorX = a[0] ?? 0;
          this.cursorY = a[1] ?? 0;
          this.syncCursorPositionToGuest();
          return { eax: 1 };
        case 'USER32.DLL!WindowFromPoint':
          return { eax: this.hitTestWindow(a[0] | 0, a[1] | 0, this.primaryWindow, false) };
        case 'USER32.DLL!ChildWindowFromPoint': {
          const hit = this.childWindowFromPoint(a[0] ?? 0, a[1] | 0, a[2] | 0, 0);
          if (shimTraceEnabled('VM_TRACE_GADGET')) {
            console.log(
              `🧭 ChildWindowFromPoint parent=0x${(a[0] ?? 0).toString(16)} cls=${this.windowClassNames.get(a[0] ?? 0)} pt=(${(a[1] ?? 0) | 0},${(a[2] ?? 0) | 0}) -> 0x${hit.toString(16)} cls=${this.windowClassNames.get(hit) ?? ''}`,
            );
          }
          return { eax: hit };
        }
        case 'USER32.DLL!ChildWindowFromPointEx': {
          const hit = this.childWindowFromPoint(a[0] ?? 0, a[1] | 0, a[2] | 0, a[3] ?? 0);
          if (shimTraceEnabled('VM_TRACE_GADGET')) {
            console.log(
              `🧭 ChildWindowFromPointEx parent=0x${(a[0] ?? 0).toString(16)} pt=(${(a[1] ?? 0) | 0},${(a[2] ?? 0) | 0}) flags=0x${(a[3] ?? 0).toString(16)} -> 0x${hit.toString(16)} cls=${this.windowClassNames.get(hit) ?? ''}`,
            );
          }
          return { eax: hit };
        }
        case 'USER32.DLL!GetFocus':
          return { eax: this.focusWindow };
        case 'USER32.DLL!GetCapture':
          if (shimTraceEnabled('VM_TRACE_INPUTAPI'))
            console.log(`🎯 GetCapture -> 0x${this.captureWindow.toString(16)}`);
          return { eax: this.captureWindow };
        case 'USER32.DLL!GetTopWindow': {
          const parent = a[0] ?? 0;
          const child = [...this.windowZOrder].reverse().find((hwnd) => (this.windowParents.get(hwnd) ?? 0) === parent);
          return { eax: child ?? 0 };
        }
        case 'USER32.DLL!GetWindow': {
          const hwnd = a[0] ?? 0;
          const relation = a[1] ?? 0;
          if (!this.windows.has(hwnd)) return { eax: 0 };
          if (relation === 4) return { eax: 0 }; // GW_OWNER: the current modeless dialog has no owner.
          if (relation === 5) {
            // GW_CHILD
            return {
              eax: [...this.windowZOrder].reverse().find((child) => this.windowParents.get(child) === hwnd) ?? 0,
            };
          }
          const parent = this.windowParents.get(hwnd) ?? 0;
          // Win32 enumerates siblings from top to bottom, following subsequent reordering.
          const siblings = this.windowZOrder
            .filter((candidate) => (this.windowParents.get(candidate) ?? 0) === parent)
            .reverse();
          const index = siblings.indexOf(hwnd);
          switch (relation) {
            case 0:
              return { eax: siblings[0] ?? 0 }; // GW_HWNDFIRST
            case 1:
              return { eax: siblings.at(-1) ?? 0 }; // GW_HWNDLAST
            case 2:
              return { eax: index >= 0 ? (siblings[index + 1] ?? 0) : 0 }; // GW_HWNDNEXT
            case 3:
              return { eax: index > 0 ? siblings[index - 1]! : 0 }; // GW_HWNDPREV
            case 6:
              return { eax: hwnd }; // GW_ENABLEDPOPUP
            default:
              return { eax: 0 };
          }
        }
        case 'USER32.DLL!SetCapture': {
          const previous = this.captureWindow;
          this.captureWindow = a[0] ?? this.primaryWindow;
          if (shimTraceEnabled('VM_TRACE_INPUTAPI'))
            console.log(
              `🎯 SetCapture hwnd=0x${(a[0] ?? 0).toString(16)} cls=${this.windowClassNames.get(a[0] ?? 0)} prev=0x${previous.toString(16)}`,
            );
          return { eax: previous };
        }
        case 'USER32.DLL!ReleaseCapture':
          if (shimTraceEnabled('VM_TRACE_INPUTAPI') && this.captureWindow)
            console.log(`🎯 ReleaseCapture (was 0x${this.captureWindow.toString(16)})`);
          this.captureWindow = 0;
          return { eax: 1 };
        case 'USER32.DLL!GetAsyncKeyState': {
          const vk = (a[0] ?? 0) & 0xff;
          const st = this.keyStates.get(vk) ? 0x8000 : 0;
          if (shimTraceEnabled('VM_TRACE_INPUTAPI') && (vk === 1 || vk === 2))
            console.log(`🎯 GetAsyncKeyState vk=${vk} -> 0x${st.toString(16)}`);
          return { eax: st };
        }
        case 'USER32.DLL!IsWindowEnabled': {
          const hwnd = a[0] ?? 0;
          const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
          return { eax: this.windows.has(hwnd) && (style & 0x08000000) === 0 ? 1 : 0 };
        }
        case 'USER32.DLL!IsWindowVisible':
          return { eax: this.isWindowVisible(a[0] ?? 0) ? 1 : 0 };
        case 'USER32.DLL!GetUpdateRect':
          if (!this.invalidatedWindows.has(a[0] ?? 0)) {
            if (a[1]) this.writeRect(a[1], 0, 0, 0, 0);
            return { eax: 0 };
          }
          if (a[1]) {
            const rect = this.windowRects.get(a[0] ?? 0);
            this.writeRect(a[1], 0, 0, rect?.width ?? this.displayWidth, rect?.height ?? this.displayHeight);
          }
          return { eax: 1 };
        case 'USER32.DLL!GetWindowLongA':
          if ((a[1] | 0) === -4) {
            const hwnd = a[0] ?? 0;
            const callback = this.windows.get(hwnd) ?? 0;
            return { eax: callback || (this.hasHostDefaultProc(hwnd) ? HOST_DEFAULT_WNDPROC : 0) };
          }
          if ((a[1] | 0) === -8) return { eax: this.windowParents.get(a[0] ?? 0) ?? 0 }; // GWL_HWNDPARENT
          return { eax: this.windowLongs.get(`${a[0] ?? 0}:${a[1] | 0}`) ?? 0 };
        case 'USER32.DLL!GetClassLongA': {
          const hwnd = a[0] ?? 0;
          const index = a[1] | 0;
          if (index === -12) return { eax: this.classCursor }; // GCL_HCURSOR
          if (index === -24) return { eax: this.windows.get(hwnd) ?? 0 }; // GCL_WNDPROC
          return { eax: 0 };
        }
        case 'USER32.DLL!ChangeDisplaySettingsA':
          return { eax: 0 }; // DISP_CHANGE_SUCCESSFUL
        case 'USER32.DLL!GetWindowThreadProcessId':
          if (a[1]) this.writeU32(a[1], this.options.processContext?.pid ?? GUEST_PROCESS_ID);
          return {
            eax: this.options.processContext
              ? this.options.processContext.kernel.threadId(this.options.processContext.pid, 0)
              : 1,
          };
        case 'USER32.DLL!SetWindowLongA': {
          const hwnd = a[0] ?? 0;
          const index = a[1] | 0;
          const value = a[2] ?? 0;
          if (index === -4) {
            const previous = this.windows.get(hwnd) ?? 0;
            if (this.windows.has(hwnd)) {
              this.windows.set(hwnd, value === HOST_DEFAULT_WNDPROC ? 0 : value);
            }
            this.syncWindowToGuest(hwnd);
            return {
              eax: previous || (this.hasHostDefaultProc(hwnd) ? HOST_DEFAULT_WNDPROC : 0),
            };
          }
          if (index === -8) {
            // GWL_HWNDPARENT
            const previous = this.windowParents.get(hwnd) ?? 0;
            if (!this.windows.has(hwnd)) return { eax: 0 };
            const id = this.controlIds.get(hwnd);
            if (id !== undefined) {
              this.dialogChildren.delete(`${previous}:${id}`);
              if (value) this.dialogChildren.set(`${value}:${id}`, hwnd);
            }
            this.windowParents.set(hwnd, value);
            this.syncWindowTreeToGuest(hwnd); // Parent-chain changes affect every descendant's absolute coordinates.
            return { eax: previous };
          }
          if (index === -12) {
            // GWL_ID
            const previous = this.controlIds.get(hwnd) ?? 0;
            if (!this.windows.has(hwnd)) return { eax: 0 };
            const parent = this.windowParents.get(hwnd) ?? 0;
            this.dialogChildren.delete(`${parent}:${previous}`);
            this.controlIds.set(hwnd, value);
            if (parent) this.dialogChildren.set(`${parent}:${value}`, hwnd);
            this.windowLongs.set(`${hwnd}:-12`, value);
            this.syncWindowToGuest(hwnd);
            return { eax: previous };
          }
          const key = `${hwnd}:${index}`;
          const previous = this.windowLongs.get(key) ?? 0;
          const visibilityChanged = index === -16 && ((previous ^ value) & 0x1000_0000) !== 0;
          if (shimTraceEnabled('VM_TRACE_WVIS') && visibilityChanged) {
            console.log(
              `👁️ SetWindowLong GWL_STYLE hwnd=0x${hwnd.toString(16)} cls=${this.windowClassNames.get(hwnd)} id=${this.controlIds.get(hwnd)} 0x${previous.toString(16)}->0x${(value >>> 0).toString(16)}`,
            );
          }
          this.windowLongs.set(key, value);
          this.syncWindowToGuest(hwnd);
          if (visibilityChanged) {
            const shellPage = this.shellPageSyncTarget(hwnd);
            if (shellPage) this.synchronizeShellPage(shellPage !== hwnd);
            if ((value & 0x1000_0000) === 0) this.hideWindowState(hwnd);
          }
          return { eax: previous };
        }
        case 'USER32.DLL!GetMenu':
          return { eax: 0 };
        case 'USER32.DLL!GetKeyState':
          return { eax: this.keyStates.get((a[0] ?? 0) & 0xff) ? 0x8000 : 0 };
        case 'USER32.DLL!SetFocus': {
          const target = a[0] ?? 0;
          const previous = this.focusWindow;
          if (!target) this.focusWindow = 0;
          else if (this.windows.has(target) && ((this.windowLongs.get(`${target}:-16`) ?? 0) & 0x08000000) === 0) {
            this.focusWindow = target;
          } else return { eax: 0 };
          return { eax: previous };
        }
        case 'USER32.DLL!SetCursor': {
          // Track the current hardware cursor and return the previous HCURSOR, matching Win32.
          const previous = this.currentCursorHandle;
          this.currentCursorHandle = a[0] ?? 0;
          return { eax: previous };
        }
        case 'USER32.DLL!GetActiveWindow':
          return { eax: this.activeWindow };
        case 'USER32.DLL!GetForegroundWindow':
          return { eax: this.foregroundWindow };
        case 'USER32.DLL!SetActiveWindow': {
          const target = a[0] ?? 0;
          if (target && !this.windows.has(target)) return { eax: 0 };
          const previous = this.activeWindow;
          this.activeWindow = target;
          return { eax: previous };
        }
        case 'USER32.DLL!SetForegroundWindow': {
          const target = a[0] ?? 0;
          if (!target || !this.windows.has(target)) return { eax: 0 };
          this.foregroundWindow = target;
          this.activeWindow = target;
          return { eax: 1 };
        }
        case 'USER32.DLL!ShowCursor': {
          // Share the guest fast stub's counter; host handling with fast-files disabled must also let
          // RA2's while (ShowCursor(FALSE) >= 0); loading loop terminate.
          const next = ((this.readU32(HYPERCALL_CURSOR_COUNT) | 0) + (a[0] ? 1 : -1)) | 0;
          this.writeU32(HYPERCALL_CURSOR_COUNT, next >>> 0);
          return { eax: next >>> 0 };
        }
        case 'USER32.DLL!RegisterHotKey':
          return { eax: 1 };
        case 'USER32.DLL!GetSystemMetrics':
          switch (a[0] ?? 0) {
            case 0:
            case 16:
              return { eax: this.displayWidth }; // SM_CXSCREEN / SM_CXFULLSCREEN
            case 1:
            case 17:
              return { eax: this.displayHeight }; // SM_CYSCREEN / SM_CYFULLSCREEN
            case 11:
            case 12:
              return { eax: 32 }; // icon
            case 13:
            case 14:
              return { eax: 32 }; // cursor
            case 19:
              return { eax: 1 }; // SM_MOUSEPRESENT
            case 43:
              return { eax: 3 }; // SM_CMOUSEBUTTONS
            default:
              return { eax: 0 };
          }
        case 'USER32.DLL!CharToOemBuffA': {
          const source = a[0] ?? 0;
          const target = a[1] ?? 0;
          const length = a[2] ?? 0;
          if (!source || !target) return { eax: 0 };
          // The current Win9x guest configures both ANSI/OEM narrow code pages for compatible DBCS;
          // Chinese CP_ACP and console OEM use identical byte pairs. Preserve every input byte
          // and explicit cchSrc length; slice first for Win32-compatible overlapping lpSrc/lpDst.
          if (length) this.memory.write_memory(this.readBytes(source, length).slice(), target);
          return { eax: 1 };
        }
        case 'USER32.DLL!wsprintfA':
          return { eax: this.wsprintfA(call) };
        case 'USER32.DLL!MessageBoxA':
          console.log(
            `🔔 MessageBoxA text=${JSON.stringify(this.readCString(a[1] ?? 0))} caption=${JSON.stringify(this.readCString(a[2] ?? 0))}`,
          );
          return { eax: defaultMessageBoxResult(a[3] ?? 0) };
        case 'USER32.DLL!MessageBoxIndirectA': {
          const params = a[0] ?? 0;
          if (!params || this.readU32(params) < 24) return { eax: 0 };
          const text = this.readU32(params + 12);
          const caption = this.readU32(params + 16);
          const style = this.readU32(params + 20);
          console.log(
            `🔔 MessageBoxIndirectA text=${JSON.stringify(this.readCString(text))} caption=${JSON.stringify(this.readCString(caption))}`,
          );
          return { eax: defaultMessageBoxResult(style) };
        }
        case 'USER32.DLL!SetTimer':
          return { eax: this.setTimer(a) };
        case 'USER32.DLL!KillTimer': {
          const key = this.timerKey(a[0] ?? 0, a[1] ?? 0);
          return { eax: this.timers.delete(key) ? 1 : 0 };
        }
        case 'USER32.DLL!SendMessageA':
          if (
            shimTraceEnabled('VM_TRACE_GADGET') &&
            (((a[1] ?? 0) >= 0x200 && (a[1] ?? 0) <= 0x209) ||
              (a[1] ?? 0) === 0x14f ||
              (a[1] ?? 0) === 0x111 ||
              (this.windowClassNames.get(a[0] ?? 0)?.toLowerCase() ?? '') === 'combobox')
          ) {
            console.log(
              `📨 SendMessageA hwnd=0x${(a[0] ?? 0).toString(16)} cls=${this.windowClassNames.get(a[0] ?? 0)} msg=0x${(a[1] ?? 0).toString(16)} w=0x${(a[2] ?? 0).toString(16)} l=0x${(a[3] ?? 0).toString(16)}`,
            );
          }
          return this.sendMessage(call, a);
        case 'USER32.DLL!SendDlgItemMessageA': {
          const child = this.dialogChildren.get(`${a[0] ?? 0}:${a[1] ?? 0}`) ?? 0;
          return child ? this.sendMessage(call, [child, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0]) : { eax: 0 };
        }
        case 'USER32.DLL!CallWindowProcA': {
          const callback = a[0] ?? 0;
          if (shimTraceEnabled('VM_TRACE_PAINT') && (a[2] ?? 0) === 0x000f && this.paintTraceCount < 50) {
            this.paintTraceCount++;
            console.log(
              `🎨 CallWindowProcA cb=0x${callback.toString(16)} hwnd=0x${(a[1] ?? 0).toString(16)} cls=${this.windowClassNames.get(a[1] ?? 0)} style=0x${(this.windowLongs.get(`${a[1] ?? 0}:-16`) ?? 0).toString(16)}`,
            );
          }
          if (
            shimTraceEnabled('VM_TRACE_GADGET') &&
            (((a[2] ?? 0) >= 0x200 && (a[2] ?? 0) <= 0x209) ||
              (a[2] ?? 0) === 0x14f ||
              (this.windowClassNames.get(a[1] ?? 0)?.toLowerCase() ?? '') === 'combobox')
          ) {
            console.log(
              `📞 CallWindowProcA cb=0x${callback.toString(16)} hwnd=0x${(a[1] ?? 0).toString(16)} cls=${this.windowClassNames.get(a[1] ?? 0)} msg=0x${(a[2] ?? 0).toString(16)} w=0x${(a[3] ?? 0).toString(16)} l=0x${(a[4] ?? 0).toString(16)}`,
            );
          }
          if (!callback || callback === HOST_DEFAULT_WNDPROC) {
            return this.dispatchDefaultControl(call, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0);
          }
          const hwnd = a[1] ?? 0;
          const previous = this.windows.get(hwnd);
          this.windows.set(hwnd, callback);
          const result = this.sendMessage(call, [hwnd, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0]);
          if (previous === undefined) this.windows.delete(hwnd);
          else this.windows.set(hwnd, previous);
          return result;
        }
        case 'USER32.DLL!PeekMessageA':
          this.markInputReady();
          if (this.pendingHostDispatches.length) {
            const result = this.dispatchPendingHostInput(call);
            this.refreshFastPeekBudget();
            return result;
          }
          if (this.peekMessage(a)) {
            this.refreshFastPeekBudget();
            return { eax: 1 };
          }
          {
            const delayMs = this.peekTimerDelay();
            // PeekMessage is nonblocking, but real Win9x schedulers still preempt the following loop.
            // An endless browser VM WASM/JS chain would starve macrotasks needed by
            // imminent 10/34ms UI timers. Long tooltip timers must leave the
            // battle loop nonblocking until their deadline approaches.
            if (delayMs > 0) this.invalidateFastPeek();
            else this.refreshFastPeekBudget();
            return delayMs > 0 ? { eax: 0, delayMs } : { eax: 0 };
          }
        case 'USER32.DLL!GetMessageA':
          this.markInputReady();
          return this.getMessage(a);
        case 'USER32.DLL!WaitMessage': {
          return this.waitMessage();
        }
        case 'USER32.DLL!TranslateMessage':
          return { eax: 1 };
        case 'USER32.DLL!IsDialogMessageA':
          // TRUE means that the dialog manager has already translated and
          // dispatched the MSG. This shim does not perform that work here, so
          // claiming TRUE swallows every WM_PAINT/WM_TIMER in the caller's
          // canonical `if (!IsDialogMessage) DispatchMessage` loop. In
          // particular RA2 then keeps the 640x480 pre-animation controls on an
          // 800x600 shell forever. Keyboard dialog navigation can be added here
          // later; unhandled messages must continue to DispatchMessageA.
          return { eax: 0 };
        case 'USER32.DLL!DispatchMessageA':
          return { eax: this.dispatchMessage(call, a[0] ?? 0) };
        case 'USER32.DLL!DefWindowProcA':
          // Real DefWindowProc handles WM_CLOSE by calling DestroyWindow; native exit relies
          // on PostQuitMessage in WM_DESTROY, so complete that path here.
          if ((a[1] ?? 0) === 0x0010 && (a[0] ?? 0)) this.destroyWindow(call, a[0]!);
          // Native exit first asks WM_QUERYENDSESSION whether shutdown is allowed. Win32 returns
          // TRUE(1); returning 0 makes the game abandon its exit sequence.
          if ((a[1] ?? 0) === 0x0011) return { eax: 1 };
          return this.dispatchDefaultControl(call, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
        case 'USER32.DLL!PostMessageA':
          if (shimTraceEnabled('VM_TRACE_POST'))
            console.log(
              `📮 PostMessageA hwnd=0x${(a[0] ?? 0).toString(16)} msg=0x${(a[1] ?? 0).toString(16)} w=0x${(a[2] ?? 0).toString(16)} l=0x${(a[3] ?? 0).toString(16)}`,
            );
          this.queueMessage(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[0] ?? 0);
          return { eax: 1 };
        case 'USER32.DLL!PostQuitMessage':
          this.queueMessage(0x0012, a[0] ?? 0, 0, 0); // WM_QUIT
          return { eax: 0 };
        case 'USER32.DLL!DialogBoxParamA':
          // Placeholder: modal dialogs remain unimplemented. Do not parse DLGTEMPLATE, create controls,
          // run a modal message pump, or invoke the dialog procedure; return 1 directly.
          // Returning 0 makes some games exit, so placeholder 1 lets startup continue.
          // A real implementation must parse the template and pump messages until EndDialog.
          return { eax: 1 };
        default:
          void name;
          return null;
      }
    }

    /**
     * USER32 wsprintfA is cdecl variadic, so ABI argBytes must be 0.
     * Read arguments directly from the import-stub stack; RA2 loading screens mostly use %d/%s and fixed-width hexadecimal.
     */
    private wsprintfA(call: Win32Call): number {
      const destination = this.readU32(call.stack + 4);
      const formatPtr = this.readU32(call.stack + 8);
      if (!destination || !formatPtr) return 0;
      const format = this.readCString(formatPtr);
      let argument = call.stack + 12;
      const nextU32 = () => {
        const value = this.readU32(argument);
        argument += 4;
        return value;
      };
      let output = '';
      for (let cursor = 0; cursor < format.length && output.length < 1023; cursor++) {
        if (format[cursor] !== '%') {
          output += format[cursor];
          continue;
        }
        cursor++;
        if (format[cursor] === '%') {
          output += '%';
          continue;
        }
        let left = false;
        let plus = false;
        let alternate = false;
        let zero = false;
        for (;;) {
          const flag = format[cursor];
          if (flag === '-') left = true;
          else if (flag === '+') plus = true;
          else if (flag === '#') alternate = true;
          else if (flag === '0') zero = true;
          else if (flag === ' ') {
            /* Leading space for positive values; RA2 does not depend on it, so treat it as ordinary width. */
          } else break;
          cursor++;
        }
        let width = 0;
        if (format[cursor] === '*') {
          width = nextU32() | 0;
          cursor++;
        } else while (/\d/.test(format[cursor] ?? '')) width = width * 10 + Number(format[cursor++]);
        let precision = -1;
        if (format[cursor] === '.') {
          cursor++;
          precision = 0;
          if (format[cursor] === '*') {
            precision = nextU32() | 0;
            cursor++;
          } else while (/\d/.test(format[cursor] ?? '')) precision = precision * 10 + Number(format[cursor++]);
        }
        let wideString = false;
        if (format[cursor] === 'h' || format[cursor] === 'l') cursor++;
        else if (format[cursor] === 'w') {
          wideString = true;
          cursor++;
        }
        const specifier = format[cursor] ?? '';
        let value = '';
        let numeric = false;
        switch (specifier) {
          case 's':
          case 'S': {
            const pointer = nextU32();
            const wide = wideString || specifier === 'S';
            value = pointer ? (wide ? this.readUser32WideString(pointer) : this.readCString(pointer)) : '(null)';
            if (precision >= 0) value = value.slice(0, precision);
            break;
          }
          case 'c':
          case 'C':
            value = String.fromCharCode(nextU32() & (specifier === 'C' ? 0xffff : 0xff));
            break;
          case 'd':
          case 'i': {
            const signed = nextU32() | 0;
            value = `${signed}`;
            if (plus && signed >= 0) value = `+${value}`;
            numeric = true;
            break;
          }
          case 'u':
            value = `${nextU32() >>> 0}`;
            numeric = true;
            break;
          case 'x':
          case 'X': {
            value = (nextU32() >>> 0).toString(16);
            if (specifier === 'X') value = value.toUpperCase();
            if (alternate) value = `${specifier === 'X' ? '0X' : '0x'}${value}`;
            numeric = true;
            break;
          }
          case 'p':
            value = (nextU32() >>> 0).toString(16).padStart(8, '0').toUpperCase();
            numeric = true;
            break;
          default:
            // Preserve unknown format text without consuming arguments, enabling precise follow-up from frames/logs.
            value = `%${specifier}`;
            break;
        }
        if (precision > 0 && numeric) {
          const sign = value.startsWith('-') || value.startsWith('+') ? value[0]! : '';
          const digits = sign ? value.slice(1) : value;
          value = sign + digits.padStart(precision, '0');
        }
        const padding = Math.max(0, Math.abs(width) - value.length);
        if (padding) {
          const pad = zero && !left && width >= 0 && numeric ? '0' : ' ';
          if (left || width < 0) value += pad.repeat(padding);
          else if (pad === '0' && (value.startsWith('-') || value.startsWith('+'))) {
            value = value[0] + pad.repeat(padding) + value.slice(1);
          } else value = pad.repeat(padding) + value;
        }
        output += value;
      }
      output = output.slice(0, 1023);
      this.writeAscii(destination, output);
      return output.length;
    }

    private readUser32WideString(pointer: number, limit = 1023): string {
      let value = '';
      for (let index = 0; index < limit; index++) {
        const code = this.readU16(pointer + index * 2);
        if (!code) break;
        value += String.fromCharCode(code);
      }
      return value;
    }

    private hasHostDefaultProc(hwnd: number): boolean {
      return HOST_DEFAULT_CLASSES.has(this.windowClassNames.get(hwnd)?.toLowerCase() ?? '');
    }
  };
}
