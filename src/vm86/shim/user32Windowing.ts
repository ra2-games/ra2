import type { MessageState, SurfaceState, VmGdiFont, Win32Call, Win32Result } from '../win32';
import { GUEST_CALLBACK_STRIDE as CALLBACK_STRIDE, HYPERCALL_CALLBACK_DEPTH } from '../pe';
import { withGdi32 } from './gdi32';
import { shimTraceEnabled } from './state';
import type { Constructor, GuestCallbackFrame } from './state';
import { clampScrollbar, scrollbarGeometry, scrollbarLimit, type ScrollbarState } from './scrollbar';

type Gdi32Chain = InstanceType<ReturnType<typeof withGdi32>>;

type User32MessageLoopBridge = {
  sendMessage(
    call: Win32Call,
    args: number[],
    forcedReturn?: number,
    reservedFrame?: GuestCallbackFrame,
  ): { eax: number };
  queueMessage(message: number, wParam: number, lParam: number, hwnd: number, generatedPaint?: boolean): void;
  isWindowInTree(hwnd: number, root: number): boolean;
};

const OWNER_DRAW_ACTIVE = 0x0006_0090;

export function withUser32Windowing<TBase extends Constructor<Gdi32Chain>>(Base: TBase) {
  return class extends Base {
    /** Bottom-to-top HWND Z-order maintained by creation, ShowWindow, and SetWindowPos. */
    protected readonly windowZOrder: number[] = [];
    /** Fullscreen dialog page currently receiving shell drawing/input; retain page objects for restoration on return. */
    protected activeShellPage = 0;
    protected readonly ownerDrawDcs = new Map<number, number>();
    /** Validate update regions only after guest WM_PAINT callbacks return. */
    protected readonly pendingPaintValidations = new Set<number>();
    /** Distinguish update-region paint requests from explicitly posted WM_PAINT messages. */
    protected readonly generatedPaintMessages = new WeakSet<MessageState>();
    protected readonly dialogFonts = new Map<number, VmGdiFont>();
    protected readonly windowClassStyles = new Map<string, number>();
    protected paintTraceCount = 0;
    protected readonly scrollbarStates = new Map<number, ScrollbarState>();
    protected scrollbarDrag: { hwnd: number; offset: number; previousCapture: number } | null = null;
    protected createWindow(call: Win32Call): number {
      const classPtr = call.args[1] ?? 0;
      const className = classPtr > 0xffff ? this.readCString(classPtr).toLowerCase() : '';
      const hwnd = this.allocateWindowHandle();
      const callback = this.windowClasses.get(className) ?? 0;
      this.windows.set(hwnd, callback);
      this.placeWindow(hwnd, 0);
      this.windowClassNames.set(hwnd, className);
      const titlePtr = call.args[2] ?? 0;
      this.windowTexts.set(hwnd, titlePtr > 0xffff ? this.readCString(titlePtr) : '');
      const parent = call.args[8] ?? 0;
      const style = call.args[3] ?? 0;
      this.windowParents.set(hwnd, parent);
      this.windowLongs.set(`${hwnd}:-16`, style); // GWL_STYLE
      this.windowLongs.set(`${hwnd}:-20`, call.args[0] ?? 0); // GWL_EXSTYLE
      this.windowRects.set(hwnd, {
        x: call.args[4] | 0,
        y: call.args[5] | 0,
        width: Math.max(0, call.args[6] | 0),
        height: Math.max(0, call.args[7] | 0),
      });
      if ((style & 0x40000000) !== 0) {
        // For WS_CHILD, hMenu is the control ID.
        const id = call.args[9] ?? 0;
        this.controlIds.set(hwnd, id);
        this.windowLongs.set(`${hwnd}:-12`, id); // GWL_ID
        if (parent) this.dialogChildren.set(`${parent}:${id}`, hwnd);
      }
      if (className === 'combobox') this.initializeComboState(hwnd);
      if (!this.primaryWindow) {
        this.primaryWindow = hwnd;
        this.activeWindow = hwnd;
        this.foregroundWindow = hwnd;
        if ((style & 0x10000000) !== 0) this.focusWindow = hwnd;
      }
      this.syncWindowToGuest(hwnd);
      if (this.shellPageSyncTarget(hwnd)) {
        this.synchronizeShellPage(true);
      }
      return hwnd;
    }

    /**
     * CreateWindowExA synchronously sends WM_CREATE before returning. Store CREATESTRUCTA at the current callback-slot tail so it remains valid through nested APIs without consuming guest heap space.
     */
    protected beginCustomWindowCreation(call: Win32Call, hwnd: number, args: number[]): Win32Result {
      const frame = this.reserveGuestCallback();
      const createStruct = frame.trampoline + CALLBACK_STRIDE - 48;
      // CREATESTRUCTA: lpCreateParams, hInstance, hMenu, hwndParent,
      // cy, cx, y, x, style, lpszName, lpszClass, dwExStyle.
      const fields = [
        args[11] ?? 0,
        args[10] ?? 0,
        args[9] ?? 0,
        args[8] ?? 0,
        args[7] ?? 0,
        args[6] ?? 0,
        args[5] ?? 0,
        args[4] ?? 0,
        args[3] ?? 0,
        args[2] ?? 0,
        args[1] ?? 0,
        args[0] ?? 0,
      ];
      fields.forEach((value, index) => this.writeU32(createStruct + index * 4, value));
      return (this as unknown as User32MessageLoopBridge).sendMessage(
        call,
        [hwnd, 0x0001, 0, createStruct],
        hwnd,
        frame,
      ); // WM_CREATE
    }
    protected createMciWindow(call: Win32Call): number {
      // MCIWndCreateA uses cdecl: the IAT stub must not pop arguments, but all four still follow the return address.
      const parent = this.readU32(call.stack + 4) || this.primaryWindow;
      const hwnd = this.allocateWindowHandle();
      this.mciWindows.set(hwnd, { parent, playing: false });
      return hwnd;
    }
    /**
     * Real DestroyWindow synchronously sends WM_DESTROY to WndProc, whose PostQuitMessage ends the main pump. This is essential to native End Game exit. Use the SendMessageA trampoline and remove windows only after WndProc returns.
     */
    protected destroyWindow(call: Win32Call, hwnd: number): void {
      if (!this.windows.has(hwnd) || this.pendingWindowDestroys.has(hwnd)) return;
      if (this.windows.get(hwnd)) {
        const frame = this.reserveGuestCallback();
        this.pendingWindowDestroys.set(hwnd, frame.ownerAddress);
        (this as unknown as User32MessageLoopBridge).sendMessage(call, [hwnd, 0x0002, 0, 0], 1, frame); // WM_DESTROY
        return;
      }
      this.finalizeWindowDestroy(hwnd);
    }

    /** Reclaim after this WM_DESTROY callback slot is released; outer modal menus may remain active indefinitely. */
    protected flushDestroyedWindows(): void {
      for (const [hwnd, ownerAddress] of this.pendingWindowDestroys) {
        if (this.readU32(ownerAddress) !== 0) continue;
        this.pendingWindowDestroys.delete(hwnd);
        this.finalizeWindowDestroy(hwnd);
      }
    }

    protected finalizeWindowDestroy(hwnd: number): void {
      if (!this.windows.has(hwnd)) return;
      const exposedParent = this.windowParents.get(hwnd) ?? 0;
      // Clear primaryWindow when destroying its window, since it is the default host-mouse target;
      // otherwise messages go to a destroyed HWND and never reach the game.
      // Win32 destroys all children first. RA2 page changes call only DestroyWindow(dialog),
      // not each template control; leftover child HWNDs keep drawing old buttons/titles
      // over the new skirmish page. Collect the whole subtree in postorder and clean it together.
      const doomed = new Set<number>([hwnd]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [child, parent] of this.windowParents) {
          if (!doomed.has(parent) || doomed.has(child)) continue;
          doomed.add(child);
          changed = true;
        }
      }
      const shellPageAffected = this.destructionAffectsShellPage(doomed);
      if (hwnd === this.primaryWindow) this.primaryWindow = 0;
      for (const target of doomed) this.forgetWindow(target);
      for (const [key, child] of [...this.dialogChildren]) {
        const parent = Number(key.slice(0, key.indexOf(':')));
        if (doomed.has(child) || doomed.has(parent)) this.dialogChildren.delete(key);
      }
      for (let index = this.messages.length - 1; index >= 0; index--) {
        if (doomed.has(this.messages[index]!.hwnd)) this.messages.splice(index, 1);
      }
      for (let index = this.pendingHostDispatches.length - 1; index >= 0; index--) {
        if (doomed.has(this.pendingHostDispatches[index]!.hwnd)) this.pendingHostDispatches.splice(index, 1);
      }
      for (let index = this.pendingHostMessages.length - 1; index >= 0; index--) {
        if (doomed.has(this.pendingHostMessages[index]!.hwnd)) this.pendingHostMessages.splice(index, 1);
      }
      for (const key of [...this.timers.keys()]) {
        const owner = Number(key.slice(0, key.indexOf(':')));
        if (doomed.has(owner)) this.timers.delete(key);
      }
      if (shellPageAffected) this.synchronizeShellPage();
      // Destroying children exposes the parent client area; send parent WM_PAINT to erase old-page
      // button/title pixels already written into the DirectDraw front surface.
      if (exposedParent && !doomed.has(exposedParent)) this.invalidateWindow(exposedParent);
    }

    protected hasShellTitleControl(page: number): boolean {
      const titleControlId = this.gameProfile.shell?.titleControlId;
      if (titleControlId === undefined || !page) return false;
      for (const [candidate, parent] of this.windowParents) {
        if (parent === page && this.windows.has(candidate) && this.controlIds.get(candidate) === titleControlId) {
          return true;
        }
      }
      return false;
    }

    protected isShellPage(hwnd: number): boolean {
      return (
        !!hwnd &&
        hwnd !== this.primaryWindow &&
        this.windowClassNames.get(hwnd)?.toLowerCase() === '#32770' &&
        !!this.primaryWindow &&
        (this as unknown as User32MessageLoopBridge).isWindowInTree(hwnd, this.primaryWindow) &&
        this.hasShellTitleControl(hwnd)
      );
    }

    /** Only page roots and direct title controls trigger full shell-page synchronization; ordinary child visibility/text changes must not scan the entire window tree. */
    protected shellPageSyncTarget(hwnd: number): number {
      const titleControlId = this.gameProfile.shell?.titleControlId;
      if (titleControlId === undefined || !hwnd || !this.windows.has(hwnd)) return 0;
      if (this.windowClassNames.get(hwnd)?.toLowerCase() === '#32770') {
        return this.isShellPage(hwnd) ? hwnd : 0;
      }
      if (this.controlIds.get(hwnd) !== titleControlId) return 0;
      const parent = this.windowParents.get(hwnd) ?? 0;
      return this.isShellPage(parent) ? parent : 0;
    }

    protected shellPageForWindow(hwnd: number): number {
      const seen = new Set<number>();
      let current = hwnd;
      while (current && !seen.has(current)) {
        seen.add(current);
        if (this.isShellPage(current)) return current;
        current = this.windowParents.get(current) ?? 0;
      }
      return 0;
    }

    protected destructionAffectsShellPage(doomed: ReadonlySet<number>): boolean {
      const titleControlId = this.gameProfile.shell?.titleControlId;
      for (const hwnd of doomed) {
        if (
          this.activeShellPage &&
          (this as unknown as User32MessageLoopBridge).isWindowInTree(hwnd, this.activeShellPage)
        )
          return true;
        if (this.isShellPage(hwnd) && this.isWindowTreeVisible(hwnd)) return true;
        if (titleControlId === undefined || this.controlIds.get(hwnd) !== titleControlId) continue;
        const shellPage = this.shellPageSyncTarget(hwnd);
        if (shellPage && (shellPage === this.activeShellPage || this.isWindowTreeVisible(shellPage))) return true;
      }
      return false;
    }

    protected shellTitleControlForPage(page: number): number {
      const titleControlId = this.gameProfile.shell?.titleControlId;
      if (titleControlId === undefined || !page) return 0;
      for (let index = this.windowZOrder.length - 1; index >= 0; index--) {
        const candidate = this.windowZOrder[index]!;
        if (
          this.windowParents.get(candidate) !== page ||
          this.controlIds.get(candidate) !== titleControlId ||
          !this.isWindowTreeVisible(candidate)
        )
          continue;
        return candidate;
      }
      return 0;
    }

    protected isVisibleShellPage(page: number): boolean {
      return this.isShellPage(page) && this.isWindowTreeVisible(page);
    }

    protected findTopVisibleShellPage(): number {
      for (let index = this.windowZOrder.length - 1; index >= 0; index--) {
        const candidate = this.windowZOrder[index]!;
        if (this.isVisibleShellPage(candidate)) return candidate;
      }
      return 0;
    }

    protected isActiveShellWindow(hwnd: number): boolean {
      if (!this.activeShellPage) return true;
      const page = this.shellPageForWindow(hwnd);
      return !page || page === this.activeShellPage;
    }

    protected synchronizeShellPage(refreshTitle = false): void {
      const nextPage = this.findTopVisibleShellPage();
      const previousPage = this.activeShellPage;
      this.activeShellPage = nextPage;

      if (previousPage !== nextPage) {
        if ((this as unknown as User32MessageLoopBridge).isWindowInTree(this.focusWindow, previousPage))
          this.focusWindow = 0;
        if ((this as unknown as User32MessageLoopBridge).isWindowInTree(this.captureWindow, previousPage))
          this.captureWindow = 0;
        if ((this as unknown as User32MessageLoopBridge).isWindowInTree(this.pressedButton, previousPage))
          this.pressedButton = 0;
        if (previousPage) {
          // A title control may be destroyed first, invalidating isShellPage for the old page; do not rely only on the identity scan below.
          this.clearWindowTreeInvalidation(previousPage);
        }
        for (const candidate of this.windowZOrder) {
          if (this.isShellPage(candidate) && candidate !== nextPage) {
            this.clearWindowTreeInvalidation(candidate);
          }
        }
      }

      if (refreshTitle || previousPage !== nextPage) this.restoreShellPageTitle();
      if (nextPage && previousPage !== nextPage) this.invalidateWindowTree(nextPage);
    }

    /** After closing a shell page, restore the next visible page's title instead of clearing global state outright. */
    protected restoreShellPageTitle(): void {
      const titleControlId = this.gameProfile.shell?.titleControlId;
      if (titleControlId === undefined || !this.activeShellPage) {
        this.shellPageTitle = '';
        return;
      }
      const titleWindow = this.shellTitleControlForPage(this.activeShellPage);
      this.shellPageTitle = titleWindow ? (this.windowTexts.get(titleWindow) ?? '') : '';
    }

    protected forgetWindow(hwnd: number): void {
      this.mciWindows.delete(hwnd);
      this.windows.delete(hwnd);
      const zIndex = this.windowZOrder.indexOf(hwnd);
      if (zIndex >= 0) this.windowZOrder.splice(zIndex, 1);
      this.windowClassNames.delete(hwnd);
      this.windowTexts.delete(hwnd);
      this.controlDisplayTexts.delete(hwnd);
      this.windowParents.delete(hwnd);
      this.windowRects.delete(hwnd);
      this.invalidatedWindows.delete(hwnd);
      this.pendingPaintValidations.delete(hwnd);
      this.pendingWindowDestroys.delete(hwnd);
      this.controlIds.delete(hwnd);
      this.trackbarStates.delete(hwnd);
      this.buttonChecks.delete(hwnd);
      this.controlItems.delete(hwnd);
      this.listboxTopIndices.delete(hwnd);
      this.controlSelections.delete(hwnd);
      this.controlItemHeights.delete(hwnd);
      this.comboStates.delete(hwnd);
      this.scrollbarStates.delete(hwnd);
      if (this.scrollbarDrag?.hwnd === hwnd) this.scrollbarDrag = null;
      this.dialogFonts.delete(hwnd);
      const ownerDrawDc = this.ownerDrawDcs.get(hwnd);
      if (ownerDrawDc) {
        this.releaseGdiDc(ownerDrawDc, this.primarySurface);
        this.ownerDrawDcs.delete(hwnd);
      }
      if (this.captureWindow === hwnd) this.captureWindow = 0;
      if (this.pressedButton === hwnd) this.pressedButton = 0;
      if (this.focusWindow === hwnd) this.focusWindow = 0;
      if (this.activeWindow === hwnd) this.activeWindow = 0;
      if (this.foregroundWindow === hwnd) this.foregroundWindow = 0;
      for (const key of [...this.windowLongs.keys()]) {
        if (key.startsWith(`${hwnd}:`)) this.windowLongs.delete(key);
      }
      this.syncWindowToGuest(hwnd); // Synchronize after all removals, clearing valid flags.
    }

    /** DLGTEMPLATE/DLGTEMPLATEEX geometry uses dialog units derived from the template font's base units. */
    protected dialogUnitRect(template: number, item: number): { x: number; y: number; width: number; height: number } {
      const extended = this.readU16(template) === 1 && this.readU16(template + 2) === 0xffff;
      const offset = item ? item : template + (extended ? 18 : 10);
      const signed16 = (address: number) => (this.readU16(address) << 16) >> 16;
      const x = signed16(offset);
      const y = signed16(offset + 2);
      const width = signed16(offset + 4);
      const height = signed16(offset + 6);
      const units = this.dialogBaseUnits(template);
      return {
        x: Math.round((x * units.x) / 4),
        y: Math.round((y * units.y) / 8),
        width: Math.max(0, Math.round((width * units.x) / 4)),
        height: Math.max(0, Math.round((height * units.y) / 8)),
      };
    }

    protected dialogBaseUnits(template: number): { x: number; y: number } {
      const extended = this.readU16(template) === 1 && this.readU16(template + 2) === 0xffff;
      const style = this.readU32(template + (extended ? 12 : 0));
      if ((style & 0x40) === 0) return { x: 6, y: 13 }; // System dialog font.
      const skip = (address: number): number => {
        const first = this.readU16(address);
        if (!first) return address + 2;
        if (first === 0xffff) return address + 4;
        while (this.readU16(address)) address += 2;
        return address + 2;
      };
      let cursor = template + (extended ? 26 : 18);
      cursor = skip(cursor); // menu
      cursor = skip(cursor); // class
      cursor = skip(cursor); // title
      const pointSize = this.readU16(cursor);
      const nominalHeight = Math.max(1, Math.round((pointSize * 96) / 72));
      // MapDialogRect uses uncropped TEXTMETRIC, while the rasterizer returns cropped actual glyphs.
      // Using cropped metrics makes dialog units vary with font tuning/characters, shifting menu geometry.
      // Win9x dialog line height includes about 1/6 external leading; average character width is about 6/13 of line height.
      const y = nominalHeight + Math.max(1, Math.round(nominalHeight / 6));
      return { x: Math.max(1, Math.round((y * 6) / 13)), y };
    }

    protected createDialogRect(template: number, hwnd: number): void {
      if (!template) {
        this.windowRects.set(hwnd, { x: 0, y: 0, width: this.displayWidth, height: this.displayHeight });
        this.syncWindowToGuest(hwnd);
        return;
      }
      const extended = this.readU16(template) === 1 && this.readU16(template + 2) === 0xffff;
      this.windowLongs.set(`${hwnd}:-20`, this.readU32(template + (extended ? 8 : 4)));
      const style = this.readU32(template + (extended ? 12 : 0));
      this.windowLongs.set(`${hwnd}:-16`, style);
      this.windowRects.set(hwnd, this.dialogUnitRect(template, 0));
      this.syncWindowToGuest(hwnd);
    }

    /** CreateDialogIndirectParam synchronously invokes dialog proc(WM_INITDIALOG) before returning. */
    protected beginDialogInitialization(call: Win32Call, hwnd: number, callback: number, initParam: number): void {
      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      this.lastCallbackState = {
        hwnd,
        message: 0x0110,
        callback,
        callStack: call.stack,
        originalReturn,
        trampoline,
        depth,
      };
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp, esp
      push(initParam);
      push(0);
      push(0x0110); // WM_INITDIALOG
      push(hwnd);
      code.push(0xb8);
      emit32(callback);
      code.push(0xff, 0xd0); // call eax
      code.push(0x89, 0xec, 0x5d); // mov esp, ebp; pop ebp
      code.push(0xb8);
      emit32(hwnd); // CreateDialogIndirectParamA returns HWND.
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
    }

    /** Build native child HWND/ID mappings from standard DLGTEMPLATE or DLGTEMPLATEEX. */
    protected createDialogChildren(template: number, parent: number): void {
      if (!template) return;
      const extended = this.readU16(template) === 1 && this.readU16(template + 2) === 0xffff;
      const style = this.readU32(template + (extended ? 12 : 0));
      const count = this.readU16(template + (extended ? 16 : 8));
      let cursor = template + (extended ? 26 : 18);
      const skipOrdinalOrString = (address: number): number => {
        const first = this.readU16(address);
        if (first === 0) return address + 2;
        if (first === 0xffff) return address + 4;
        let next = address;
        while (this.readU16(next)) next += 2;
        return next + 2;
      };
      const readOrdinalOrString = (address: number): string => {
        const first = this.readU16(address);
        if (!first) return '';
        if (first === 0xffff) return `#${this.readU16(address + 2)}`;
        let value = '';
        let next = address;
        while (this.readU16(next)) {
          value += String.fromCharCode(this.readU16(next));
          next += 2;
        }
        return value;
      };
      cursor = skipOrdinalOrString(cursor); // menu
      cursor = skipOrdinalOrString(cursor); // window class
      cursor = skipOrdinalOrString(cursor); // title
      if ((style & 0x40) !== 0) {
        // DS_SETFONT
        const pointSize = this.readU16(cursor);
        const weight = extended ? this.readU16(cursor + 2) : 400;
        const italic = extended ? this.readU8(cursor + 4) !== 0 : false;
        const charset = extended ? this.readU8(cursor + 5) : 0;
        const face = readOrdinalOrString(cursor + (extended ? 6 : 2));
        this.dialogFonts.set(parent, {
          height: -Math.max(1, Math.round((pointSize * 96) / 72)),
          width: 0,
          weight,
          italic,
          underline: false,
          strikeout: false,
          charset,
          faceName: face || 'MS Sans Serif',
        });
        cursor += extended ? 6 : 2;
        cursor = skipOrdinalOrString(cursor);
      }
      for (let index = 0; index < count; index++) {
        cursor = (cursor + 3) & ~3;
        const id = extended ? this.readU32(cursor + 20) : this.readU16(cursor + 16);
        const itemExStyle = this.readU32(cursor + 4);
        const itemStyle = this.readU32(cursor + (extended ? 8 : 0));
        const itemRect = this.dialogUnitRect(template, cursor + (extended ? 12 : 8));
        let item = cursor + (extended ? 24 : 18);
        const classStart = item;
        let className = '';
        if (this.readU16(classStart) === 0xffff) {
          className =
            (
              {
                0x80: 'Button',
                0x81: 'Edit',
                0x82: 'Static',
                0x83: 'ListBox',
                0x84: 'ScrollBar',
                0x85: 'ComboBox',
              } as Record<number, string>
            )[this.readU16(classStart + 2)] ?? '';
        } else {
          let text = classStart;
          while (this.readU16(text)) {
            className += String.fromCharCode(this.readU16(text));
            text += 2;
          }
        }
        item = skipOrdinalOrString(item); // class
        const title = readOrdinalOrString(item);
        item = skipOrdinalOrString(item); // title
        const extra = this.readU16(item);
        cursor = item + 2 + extra;
        const key = `${parent}:${id}`;
        if (this.dialogChildren.has(key)) continue;
        const hwnd = this.allocateWindowHandle();
        this.dialogChildren.set(key, hwnd);
        this.windows.set(hwnd, 0);
        this.placeWindow(hwnd, 0);
        this.windowClassNames.set(hwnd, className);
        this.windowTexts.set(hwnd, title);
        this.windowParents.set(hwnd, parent);
        this.windowRects.set(hwnd, itemRect);
        this.windowLongs.set(`${hwnd}:-20`, itemExStyle);
        this.windowLongs.set(`${hwnd}:-16`, itemStyle);
        this.windowLongs.set(`${hwnd}:-12`, id);
        this.controlIds.set(hwnd, id);
        this.syncWindowToGuest(hwnd);
        if (className.toLowerCase() === 'combobox') this.initializeComboState(hwnd);
        if ((itemStyle & 0x10000000) !== 0) this.invalidateWindow(hwnd); // WS_VISIBLE
      }
      this.invalidateWindow(parent);
      if (this.shellPageSyncTarget(parent)) this.synchronizeShellPage(true);
    }

    protected screenOrigin(hwnd: number): { x: number; y: number } {
      let x = 0;
      let y = 0;
      const seen = new Set<number>();
      while (hwnd && !seen.has(hwnd)) {
        seen.add(hwnd);
        const rect = this.windowRects.get(hwnd);
        if (rect) {
          x += rect.x;
          y += rect.y;
        }
        hwnd = this.windowCoordinateParent(hwnd);
      }
      return { x, y };
    }

    protected screenRect(hwnd: number): { x: number; y: number; width: number; height: number } {
      if (!hwnd) return { x: 0, y: 0, width: this.displayWidth, height: this.displayHeight };
      const origin = this.screenOrigin(hwnd);
      const rect = this.windowRects.get(hwnd);
      return { x: origin.x, y: origin.y, width: rect?.width ?? 0, height: rect?.height ?? 0 };
    }

    protected dialogFontForWindow(hwnd: number): VmGdiFont | undefined {
      while (hwnd && !this.dialogFonts.has(hwnd)) hwnd = this.windowParents.get(hwnd) ?? 0;
      return this.dialogFonts.get(hwnd);
    }

    /**
     * For CBS_DROPDOWN/CBS_DROPDOWNLIST, creation cy is total expanded height, but the persistent HWND rectangle is only the selection box. Preserve full height for CB_GETDROPPEDCONTROLRECT. Treating both as one 121px window mispositions RA2 owner-drawn selections across the list and overwrites several UI rows below.
     */
    protected initializeComboState(hwnd: number) {
      const existing = this.comboStates.get(hwnd);
      if (existing) return existing;
      const rect = this.windowRects.get(hwnd) ?? { x: 0, y: 0, width: 0, height: 0 };
      const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
      const dropdown = (style & 0x3) !== 0x1; // CBS_SIMPLE keeps its list permanently visible.
      const fontHeight = Math.abs(this.dialogFontForWindow(hwnd)?.height ?? -11);
      const itemHeight = Math.max(1, fontHeight + 5);
      const closedHeight = itemHeight + 4;
      const state = {
        selectionHeight: itemHeight,
        itemHeight,
        dropped: false,
        droppedWidth: rect.width,
        droppedHeight: Math.max(rect.height, closedHeight),
      };
      this.comboStates.set(hwnd, state);
      if (dropdown && rect.height !== closedHeight) {
        this.windowRects.set(hwnd, { ...rect, height: closedHeight });
        this.syncWindowTreeToGuest(hwnd);
      }
      return state;
    }

    /**
     * Dropdown ComboBoxes have separate closed selection-box height and expanded CB_GETDROPPEDCONTROLRECT extent. Layout often creates/moves at full height, then aligns using closed height. The latter must not shrink the saved dropdown extent to one row, or owner-drawn popups without explicit max-row show only the first item.
     */
    protected resizeComboHeight(hwnd: number, requestedHeight: number): number {
      if (this.windowClassNames.get(hwnd)?.toLowerCase() !== 'combobox') return requestedHeight;
      const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
      if ((style & 0x3) === 0x1) return requestedHeight; // CBS_SIMPLE
      const combo = this.initializeComboState(hwnd);
      const closedHeight = combo.selectionHeight + 4;
      if (requestedHeight > closedHeight) combo.droppedHeight = requestedHeight;
      else combo.droppedHeight = Math.max(combo.droppedHeight, closedHeight);
      return closedHeight;
    }

    /** RA2 的 owner-draw 下拉列表只把右侧三角作为展开按钮；文字区由 Gadget 保持静态。 */
    protected isComboDropButtonHit(hwnd: number, lParam: number): boolean {
      const shell = this.gameProfile.shell;
      const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
      if (!shell?.initializeComboDropWindow || (style & 0x3) !== 0x3) return true;
      const rect = this.windowRects.get(hwnd);
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const x = (lParam << 16) >> 16;
      const y = lParam >> 16;
      // 资源中的三角按钮宽度约为框宽的 1/6；限制在 16..24px，适配 800×600 UI。
      const buttonWidth = Math.max(16, Math.min(24, Math.ceil(rect.width / 6)));
      return x >= rect.width - buttonWidth && x < rect.width && y >= 0 && y < rect.height;
    }

    /** 下拉列表画在 primary 的临时区域；收起时从当前 shell 背景层恢复这块区域。
     * RGB565 的 0 在当前最终帧路径里是实际黑色，不能再把它当作透明色写回 primary。 */
    protected setComboDropped(hwnd: number, dropped: boolean): void {
      const combo = this.initializeComboState(hwnd);
      if (combo.dropped === dropped) return;
      const wasDropped = combo.dropped;
      combo.dropped = dropped;
      if (wasDropped && !dropped) {
        const surface = this.surfaces.get(this.primarySurface);
        const rect = this.windowRects.get(hwnd);
        if (surface?.bpp === 16 && rect && combo.droppedHeight > rect.height) {
          const origin = this.screenOrigin(hwnd);
          this.restoreShellRectFromBackground(surface, [
            origin.x,
            origin.y + rect.height,
            origin.x + Math.max(rect.width, combo.droppedWidth),
            origin.y + combo.droppedHeight,
          ]);
          surface.dirty = true;
          this.emitPrimaryFrame();
        }
      }
      this.invalidateWindow(hwnd);
    }

    protected invalidateWindow(hwnd: number): void {
      // Hidden windows/subtrees generate no system paint messages; invalidateWindowTree repaints when shown.
      if (!this.isWindowVisible(hwnd)) return;
      // DirectDraw owner-draw procedures do not call BeginPaint. If they
      // invalidate themselves while the current WM_PAINT callback is still on
      // the guest stack, that is a request for another paint, not a duplicate
      // of the paint already in progress. Cancel the old validation boundary
      // and enqueue one replacement message.
      const paintInProgress = this.pendingPaintValidations.delete(hwnd);
      if (this.invalidatedWindows.has(hwnd) && !paintInProgress) return;
      this.invalidatedWindows.add(hwnd);
      (this as unknown as User32MessageLoopBridge).queueMessage(0x000f, 0, 0, hwnd, true); // WM_PAINT coalesces per HWND.
    }

    /**
     * Synchronous painting may finish before message pumping. On update-region validation, cancel unconsumed system paint requests or stale WM_PAINT erases the background again while empty GetUpdateRect prevents text repainting.
     */
    protected validateWindow(hwnd: number): void {
      this.invalidatedWindows.delete(hwnd);
      this.pendingPaintValidations.delete(hwnd);
      for (let index = this.messages.length - 1; index >= 0; index--) {
        const message = this.messages[index]!;
        if (message.hwnd === hwnd && this.generatedPaintMessages.has(message)) this.messages.splice(index, 1);
      }
    }

    /**
     * SendMessage/DispatchMessage execute callbacks through guest trampolines; painting is unfinished when the host returns. Retain update regions until callback exit for GetUpdateRect during painting.
     */
    protected flushPendingPaintValidations(): void {
      if (!this.pendingPaintValidations.size || this.readU32(HYPERCALL_CALLBACK_DEPTH) !== 0) return;
      for (const hwnd of this.pendingPaintValidations) this.validateWindow(hwnd);
      this.pendingPaintValidations.clear();
    }

    protected invalidateWindowTree(root: number): void {
      for (const hwnd of this.windows.keys()) {
        if ((this as unknown as User32MessageLoopBridge).isWindowInTree(hwnd, root) && this.isWindowTreeVisible(hwnd)) {
          this.invalidateWindow(hwnd);
        }
      }
    }

    protected clearWindowTreeInvalidation(root: number): void {
      const cleared = new Set<number>();
      for (const hwnd of this.windows.keys()) {
        if (!(this as unknown as User32MessageLoopBridge).isWindowInTree(hwnd, root)) continue;
        cleared.add(hwnd);
        this.invalidatedWindows.delete(hwnd);
      }
      // WM_PAINT queued while hidden no longer has its update region. Clearing only the Set, not messages,
      // runs stale paint after showing and may incorrectly coalesce new invalidations.
      for (let index = this.messages.length - 1; index >= 0; index--) {
        const message = this.messages[index]!;
        if (message.message === 0x000f && cleared.has(message.hwnd)) this.messages.splice(index, 1);
      }
    }

    protected hideWindowState(hwnd: number, redraw = true): void {
      if (!hwnd || !this.windows.has(hwnd)) return;
      if ((this as unknown as User32MessageLoopBridge).isWindowInTree(this.focusWindow, hwnd)) this.focusWindow = 0;
      if ((this as unknown as User32MessageLoopBridge).isWindowInTree(this.captureWindow, hwnd)) this.captureWindow = 0;
      if ((this as unknown as User32MessageLoopBridge).isWindowInTree(this.pressedButton, hwnd)) this.pressedButton = 0;
      this.clearWindowTreeInvalidation(hwnd);
      if (redraw) this.invalidateWindow(this.windowParents.get(hwnd) ?? 0);
    }

    /** Discard WM_PAINT left from inactive pages; also handle stale queued messages here. */
    protected discardInactivePaint(hwnd: number): boolean {
      if (this.isActiveShellWindow(hwnd)) return false;
      this.invalidatedWindows.delete(hwnd);
      return true;
    }

    protected isWindowVisible(hwnd: number): boolean {
      if (!hwnd || !this.windows.has(hwnd)) return false;
      const seen = new Set<number>();
      let current = hwnd;
      while (current && !seen.has(current)) {
        seen.add(current);
        if (((this.windowLongs.get(`${current}:-16`) ?? 0) & 0x10000000) === 0) return false;
        current = this.windowParents.get(current) ?? 0;
      }
      return true;
    }

    protected copyWindowText(hwnd: number, destination: number, capacity: number): number {
      if (!hwnd || !destination || capacity <= 0) return 0;
      const value = this.windowTexts.get(hwnd) ?? '';
      const written = Math.min(value.length, capacity - 1);
      this.writeAscii(destination, value.slice(0, written));
      return written;
    }

    /**
     * Native subclasses read template text through old system procedures; system Buttons send BN_CLICKED/WM_COMMAND to parent dialogs on release.
     */
    protected activateButton(hwnd: number): void {
      const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
      const type = style & 0x0f;
      if (type === 0x03) {
        // BS_AUTOCHECKBOX
        this.buttonChecks.set(hwnd, this.buttonChecks.get(hwnd) ? 0 : 1);
        this.invalidateWindow(hwnd);
        return;
      }
      if (type === 0x06) {
        // BS_AUTO3STATE
        this.buttonChecks.set(hwnd, ((this.buttonChecks.get(hwnd) ?? 0) + 1) % 3);
        this.invalidateWindow(hwnd);
        return;
      }
      if (type !== 0x09) return; // BS_AUTORADIOBUTTON

      const parent = this.windowParents.get(hwnd) ?? 0;
      const siblings = [...this.windowParents]
        .filter(([, candidateParent]) => candidateParent === parent)
        .map(([sibling]) => sibling);
      const index = siblings.indexOf(hwnd);
      if (index < 0) return;
      let first = index;
      while (first > 0 && ((this.windowLongs.get(`${siblings[first]}:-16`) ?? 0) & 0x0002_0000) === 0) {
        first--;
      }
      let last = index + 1;
      while (last < siblings.length && ((this.windowLongs.get(`${siblings[last]}:-16`) ?? 0) & 0x0002_0000) === 0) {
        last++;
      }
      for (let i = first; i < last; i++) {
        const sibling = siblings[i]!;
        const siblingType = (this.windowLongs.get(`${sibling}:-16`) ?? 0) & 0x0f;
        if (siblingType !== 0x04 && siblingType !== 0x09) continue;
        const checked = sibling === hwnd ? 1 : 0;
        if ((this.buttonChecks.get(sibling) ?? 0) === checked) continue;
        this.buttonChecks.set(sibling, checked);
        this.invalidateWindow(sibling);
      }
    }

    protected syncListBoxSelectionMessage(hwnd: number, message: number, wParam: number, lParam: number): boolean {
      if ((this.windowClassNames.get(hwnd)?.toLowerCase() ?? '') !== 'listbox') return false;
      const items = this.controlItems.get(hwnd);
      if (!items) return false;
      const selection = this.controlSelections.get(hwnd) ?? -1;
      if (message === 0x0185) {
        // LB_SETSEL
        const index = lParam | 0;
        if (index < 0 || index >= items.length) return false;
        if (wParam) this.controlSelections.set(hwnd, index);
        else if (selection === index) this.controlSelections.set(hwnd, -1);
        return true;
      }
      if (message === 0x0186) {
        // LB_SETCURSEL
        const index = wParam | 0;
        if (index < -1 || index >= items.length) return false;
        this.controlSelections.set(hwnd, index);
        return true;
      }
      return false;
    }

    protected defaultControlProc(hwnd: number, message: number, wParam: number, lParam: number): number {
      const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
      if (message === 0x000f) {
        // WM_PAINT
        if (this.discardInactivePaint(hwnd)) return 0;
        if (className === 'scrollbar') {
          const primary = this.surfaces.get(this.primarySurface);
          if (primary) primary.dirty = true;
          this.emitPrimaryFrame();
        }
        // Standard controls maintain only Win32 state; the game's DirectDraw/owner-draw code determines
        // visible RA2/YR shell appearance. Do not synthesize template borders: templates retain
        // eight skirmish slots, while game drawing clips them to the map's actual player count.
        this.invalidatedWindows.delete(hwnd);
        return 0;
      }
      if (className === 'msctls_trackbar32') {
        const state = this.trackbarStates.get(hwnd) ?? { min: 0, max: 100, pos: 0 };
        this.trackbarStates.set(hwnd, state);
        const clampPos = () => {
          state.pos = Math.max(state.min, Math.min(state.max, state.pos));
        };
        switch (message) {
          case 0x0400:
            return state.pos; // TBM_GETPOS
          case 0x0401:
            return state.min; // TBM_GETRANGEMIN
          case 0x0402:
            return state.max; // TBM_GETRANGEMAX
          case 0x0405: // TBM_SETPOS
            state.pos = lParam | 0;
            clampPos();
            if (wParam) this.invalidateWindow(hwnd);
            return 0;
          case 0x0406: {
            // TBM_SETRANGE: LOWORD=min, HIWORD=max
            state.min = (lParam << 16) >> 16;
            state.max = lParam >> 16;
            if (state.max < state.min) [state.min, state.max] = [state.max, state.min];
            clampPos();
            if (wParam) this.invalidateWindow(hwnd);
            return 0;
          }
          case 0x0407: // TBM_SETRANGEMIN
            state.min = lParam | 0;
            if (state.max < state.min) state.max = state.min;
            clampPos();
            return 0;
          case 0x0408: // TBM_SETRANGEMAX
            state.max = lParam | 0;
            if (state.min > state.max) state.min = state.max;
            clampPos();
            return 0;
          case 0x0414:
            return 1; // TBM_SETLINESIZE returns the old value.
          case 0x0415:
            return 1; // TBM_GETLINESIZE
          case 0x0416:
            return 10; // TBM_SETPAGESIZE returns the old value.
          case 0x0417:
            return 10; // TBM_GETPAGESIZE
          case 0x041b:
            return 20; // TBM_GETTHUMBLENGTH
          default:
            break;
        }
      }

      if (className === 'button') {
        switch (message) {
          case 0x00f0:
            return this.buttonChecks.get(hwnd) ?? 0; // BM_GETCHECK
          case 0x00f1: // BM_SETCHECK
            this.buttonChecks.set(hwnd, wParam & 3);
            this.invalidateWindow(hwnd);
            return 0;
          case 0x00f2:
            return this.buttonChecks.get(hwnd) ?? 0; // BM_GETSTATE
          case 0x00f3:
            return 0; // BM_SETSTATE
          case 0x00f5:
            return 0; // BM_CLICK: guest pages handle actual clicks through WM_COMMAND.
          default:
            break;
        }
      }

      if (className === 'edit') {
        if (message === 0x0102) {
          // WM_CHAR
          const current = this.windowTexts.get(hwnd) ?? '';
          let next = current;
          if (wParam === 0x08)
            next = current.slice(0, -1); // Backspace
          else if (wParam >= 0x20 && wParam !== 0x7f && current.length < 31) {
            next += String.fromCharCode(wParam & 0xff);
          }
          if (next !== current) {
            this.windowTexts.set(hwnd, next);
            this.invalidateWindow(hwnd);
          }
          return 0;
        }
      }

      if (className === 'scrollbar') {
        const state = this.scrollbarState(hwnd);
        switch (message) {
          case 0x00e0: {
            // SBM_SETPOS
            const previous = state.pos;
            state.pos = wParam | 0;
            clampScrollbar(state);
            if (lParam) this.invalidateWindow(hwnd);
            return previous;
          }
          case 0x00e1:
            return state.pos; // SBM_GETPOS
          case 0x00e2:
          case 0x00e6: // SBM_SETRANGE / SBM_SETRANGEREDRAW
            state.min = wParam | 0;
            state.max = lParam | 0;
            clampScrollbar(state);
            if (message === 0x00e6) this.invalidateWindow(hwnd);
            return 0;
          case 0x00e3: // SBM_GETRANGE
            if (wParam) this.writeU32(wParam, state.min);
            if (lParam) this.writeU32(lParam, state.max);
            return 0;
          case 0x00e4: // SBM_ENABLE_ARROWS
            state.disabled = wParam & 3;
            this.invalidateWindow(hwnd);
            return 1;
          case 0x00e9:
          case 0x00ea: {
            // SBM_SETSCROLLINFO / SBM_GETSCROLLINFO
            if (!lParam || ![24, 28].includes(this.readU32(lParam))) return 0;
            const mask = this.readU32(lParam + 4);
            if (message === 0x00ea) {
              if (mask & 1) {
                this.writeU32(lParam + 8, state.min);
                this.writeU32(lParam + 12, state.max);
              }
              if (mask & 2) this.writeU32(lParam + 16, state.page);
              if (mask & 4) this.writeU32(lParam + 20, state.pos);
              if (mask & 16 && this.readU32(lParam) >= 28) this.writeU32(lParam + 24, state.trackPos);
              return mask & 0x17 ? 1 : 0;
            }
            if (mask & 1) {
              state.min = this.readU32(lParam + 8) | 0;
              state.max = this.readU32(lParam + 12) | 0;
            }
            if (mask & 2) state.page = this.readU32(lParam + 16);
            if (mask & 4) state.pos = this.readU32(lParam + 20) | 0;
            clampScrollbar(state);
            if (wParam) this.invalidateWindow(hwnd);
            return state.pos;
          }
        }
      }

      if (className === 'combobox') {
        const items = this.controlItems.get(hwnd) ?? [];
        this.controlItems.set(hwnd, items);
        const selection = () => this.controlSelections.get(hwnd) ?? -1;
        const combo = this.initializeComboState(hwnd);
        const selectedText = () => items[selection()]?.text ?? '';
        switch (message) {
          case 0x000d: {
            // WM_GETTEXT: dropdown lists return selected-item text.
            if (!lParam || wParam <= 0) return 0;
            const text = selectedText();
            const written = Math.min(text.length, wParam - 1);
            this.writeAscii(lParam, text.slice(0, written));
            return written;
          }
          case 0x000e:
            return selectedText().length; // WM_GETTEXTLENGTH
          case 0x0143: {
            // CB_ADDSTRING
            items.push({ text: lParam ? this.readCString(lParam) : '', data: 0 });
            return items.length - 1;
          }
          case 0x0144: {
            // CB_DELETESTRING
            if (wParam >= items.length) return -1;
            items.splice(wParam, 1);
            if (selection() >= items.length) this.controlSelections.set(hwnd, items.length - 1);
            return items.length;
          }
          case 0x0146:
            return items.length; // CB_GETCOUNT
          case 0x0147:
            return selection(); // CB_GETCURSEL
          case 0x0148: {
            // CB_GETLBTEXT
            const item = items[wParam];
            if (!item || !lParam) return -1;
            this.writeAscii(lParam, item.text);
            return item.text.length;
          }
          case 0x0149:
            return items[wParam]?.text.length ?? -1; // CB_GETLBTEXTLEN
          case 0x014a: {
            // CB_INSERTSTRING
            const index = wParam < 0 || wParam > items.length ? items.length : wParam;
            items.splice(index, 0, { text: lParam ? this.readCString(lParam) : '', data: 0 });
            return index;
          }
          case 0x014b: // CB_RESETCONTENT
            items.length = 0;
            this.controlSelections.set(hwnd, -1);
            return 0;
          case 0x014e: {
            // CB_SETCURSEL
            const index = wParam | 0;
            if (index < -1 || index >= items.length) return -1;
            this.controlSelections.set(hwnd, index);
            this.invalidateWindow(hwnd);
            return index;
          }
          case 0x014f: // CB_SHOWDROPDOWN
            this.setComboDropped(hwnd, wParam !== 0);
            return 1;
          case 0x0150:
            return items[wParam]?.data ?? -1; // CB_GETITEMDATA
          case 0x0151: // CB_SETITEMDATA
            if (!items[wParam]) return -1;
            items[wParam]!.data = lParam >>> 0;
            return 0;
          case 0x0152: {
            // CB_GETDROPPEDCONTROLRECT uses screen coordinates and includes the expanded list.
            if (!lParam) return 0;
            const rect = this.screenRect(hwnd);
            const width = Math.max(rect.width, combo.droppedWidth);
            this.writeRect(lParam, rect.x, rect.y, rect.x + width, rect.y + combo.droppedHeight);
            return 1;
          }
          case 0x0153: {
            // CB_SETITEMHEIGHT: -1 denotes selection-box height.
            const height = lParam & 0xffff;
            if (height <= 0 || height > 0x7fff) return -1; // CB_ERR
            if ((wParam | 0) === -1) {
              combo.selectionHeight = height;
              combo.droppedHeight = Math.max(combo.droppedHeight, height + 4);
              const rect = this.windowRects.get(hwnd);
              const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
              if (rect && (style & 0x3) !== 0x1) {
                this.windowRects.set(hwnd, { ...rect, height: height + 4 });
                this.syncWindowTreeToGuest(hwnd);
              }
            } else combo.itemHeight = height;
            return 0;
          }
          case 0x0154: // CB_GETITEMHEIGHT
            return (wParam | 0) === -1 ? combo.selectionHeight : combo.itemHeight;
          case 0x0157:
            return combo.dropped ? 1 : 0; // CB_GETDROPPEDSTATE
          case 0x0158: {
            // CB_FINDSTRINGEXACT
            const needle = lParam ? this.readCString(lParam).toLowerCase() : '';
            return items.findIndex((item) => item.text.toLowerCase() === needle);
          }
          case 0x015f:
            return combo.droppedWidth; // CB_GETDROPPEDWIDTH
          case 0x0160: {
            // CB_SETDROPPEDWIDTH returns the final width.
            combo.droppedWidth = Math.max(this.windowRects.get(hwnd)?.width ?? 0, wParam | 0);
            return combo.droppedWidth;
          }
          case 0x0161:
            return items.length; // CB_INITSTORAGE
          default:
            break;
        }
      }

      if (className === 'listbox') {
        const items = this.controlItems.get(hwnd) ?? [];
        this.controlItems.set(hwnd, items);
        const selection = () => this.controlSelections.get(hwnd) ?? -1;
        switch (message) {
          case 0x000f:
            return 0; // The game's owner-draw/DirectDraw path owns visible appearance.
          case 0x0180: // LB_ADDSTRING
            items.push({ text: lParam ? this.readCString(lParam) : '', data: 0 });
            this.invalidateWindow(hwnd);
            return items.length - 1;
          case 0x0181: {
            // LB_INSERTSTRING
            const index = wParam > items.length ? items.length : wParam;
            items.splice(index, 0, { text: lParam ? this.readCString(lParam) : '', data: 0 });
            this.invalidateWindow(hwnd);
            return index;
          }
          case 0x0182: // LB_DELETESTRING
            if (!items[wParam]) return -1;
            items.splice(wParam, 1);
            this.invalidateWindow(hwnd);
            return items.length;
          case 0x0184: // LB_RESETCONTENT
            items.length = 0;
            this.controlSelections.set(hwnd, -1);
            this.listboxTopIndices.set(hwnd, 0);
            this.invalidateWindow(hwnd);
            return 0;
          case 0x0185: // LB_SETSEL
            if (!this.syncListBoxSelectionMessage(hwnd, message, wParam, lParam)) return -1;
            this.invalidateWindow(hwnd);
            return 1;
          case 0x0186: {
            // LB_SETCURSEL
            if (!this.syncListBoxSelectionMessage(hwnd, message, wParam, lParam)) return -1;
            this.invalidateWindow(hwnd);
            return wParam | 0;
          }
          case 0x0187: {
            // LB_GETSEL
            const index = wParam | 0;
            return index >= 0 && index < items.length && selection() === index ? 1 : 0;
          }
          case 0x0188:
            return selection(); // LB_GETCURSEL
          case 0x0198: {
            // LB_GETITEMRECT
            const item = items[wParam];
            if (!item || !lParam) return -1;
            const rect = this.windowRects.get(hwnd);
            const height = this.controlItemHeights.get(hwnd) ?? 16;
            // Item rectangles follow scroll offset: visible rows start at client top, with negative positions before the top index.
            const top = this.listboxTopIndices.get(hwnd) ?? 0;
            const y = (wParam - top) * height;
            this.writeRect(lParam, 0, y, rect?.width ?? 0, y + height);
            return 1;
          }
          case 0x0189: {
            // LB_GETTEXT
            const item = items[wParam];
            if (!item || !lParam) return -1;
            this.writeAscii(lParam, item.text);
            return item.text.length;
          }
          case 0x018a:
            return items[wParam]?.text.length ?? -1; // LB_GETTEXTLEN
          case 0x018b:
            return items.length; // LB_GETCOUNT
          case 0x018e: // LB_GETTOPINDEX clamps the top index after items are removed.
            return Math.min(this.listboxTopIndices.get(hwnd) ?? 0, Math.max(0, items.length - 1));
          case 0x0197: {
            // LB_SETTOPINDEX
            const index = wParam | 0;
            // Allow the last item at the top; return LB_ERR for out-of-range requests without changing state.
            if (index < 0 || index >= items.length) return -1;
            if ((this.listboxTopIndices.get(hwnd) ?? 0) !== index) {
              this.listboxTopIndices.set(hwnd, index);
              this.invalidateWindow(hwnd);
            }
            return 0;
          }
          case 0x01a7: {
            // LB_SETCOUNT: owner-drawn lists declare item counts without strings.
            if (wParam < 0) return -1;
            items.length = wParam;
            for (let i = 0; i < items.length; i++) items[i] ??= { text: '', data: 0 };
            this.invalidateWindow(hwnd);
            return 0;
          }
          case 0x01a0: {
            // LB_SETITEMHEIGHT
            // Owner-draw fixed listboxes use index 0; variable-height controls may
            // address a specific row. RA2 only needs the effective row height.
            const height = lParam & 0xffff;
            if (height <= 0 || height > 0xff) return -1; // LB_ERR
            this.controlItemHeights.set(hwnd, height);
            return 0;
          }
          case 0x01a1: // LB_GETITEMHEIGHT
            // USER32's default text listbox height depends on the selected font.
            // 16 is the Win9x-era default; an earlier LB_SETITEMHEIGHT overrides it.
            return this.controlItemHeights.get(hwnd) ?? 16;
          case 0x0199:
            return items[wParam]?.data ?? -1; // LB_GETITEMDATA
          case 0x019a:
            if (!items[wParam]) return -1;
            items[wParam]!.data = lParam >>> 0;
            return 0;
          case 0x01a8:
            return items.length; // LB_INITSTORAGE
          default:
            break;
        }
      }

      switch (message) {
        case 0x000c: // WM_SETTEXT
          this.windowTexts.set(hwnd, lParam ? this.readCString(lParam) : '');
          this.invalidateWindow(hwnd);
          return 1;
        case 0x000d: // WM_GETTEXT
          return this.copyWindowText(hwnd, lParam, wParam);
        case 0x000e: // WM_GETTEXTLENGTH
          return (this.windowTexts.get(hwnd) ?? '').length;
        default:
          return 0;
      }
    }

    protected dispatchDefaultControl(
      call: Win32Call,
      hwnd: number,
      message: number,
      wParam: number,
      lParam: number,
    ): Win32Result {
      const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
      const parent = this.windowParents.get(hwnd) ?? 0;
      const id = this.controlIds.get(hwnd) ?? 0;
      if (className === 'scrollbar' && [0x0200, 0x0201, 0x0202, 0x0203, 0x0100].includes(message)) {
        const state = this.scrollbarState(hwnd);
        const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
        if (style & 0x0800_0000 || state.disabled === 3) return { eax: 0 };
        const vertical = (style & 1) !== 0;
        const rect = this.windowRects.get(hwnd)!;
        const length = vertical ? rect.height : rect.width;
        const geometry = scrollbarGeometry(state, length, vertical ? rect.width : rect.height);
        const point = vertical ? lParam >> 16 : (lParam << 16) >> 16;
        const siblingOwner = this.scrollbarOwner(hwnd);
        const owner = siblingOwner || parent;
        const notifyScroll = (code: number, pos = state.pos) => {
          if (siblingOwner && code !== 8) {
            // Westwood lists read SBM_GETPOS during WM_VSCROLL, then update
            // LB_SETTOPINDEX/popup top. Commit position first or delivered notifications keep reading stale values.
            const ownerRect = this.windowRects.get(owner)!;
            const ownerClass = this.windowClassNames.get(owner)?.toLowerCase();
            const combo =
              ownerClass === 'combodropwin'
                ? [...this.comboStates].find(([candidate]) => {
                    const r = this.windowRects.get(candidate);
                    return r && r.x === ownerRect.x && r.y + r.height + 1 === ownerRect.y;
                  })?.[1]
                : undefined;
            const itemHeight = combo?.itemHeight ?? this.controlItemHeights.get(owner) ?? 16;
            const page = Math.max(1, Math.floor(ownerRect.height / itemHeight));
            state.pos =
              code === 0
                ? state.pos - 1
                : code === 1
                  ? state.pos + 1
                  : code === 2
                    ? state.pos - page
                    : code === 3
                      ? state.pos + page
                      : code === 6
                        ? state.min
                        : code === 7
                          ? scrollbarLimit(state)
                          : pos;
            clampScrollbar(state);
            this.invalidateWindow(hwnd);
          }
          return (this as unknown as User32MessageLoopBridge).sendMessage(call, [
            owner,
            vertical ? 0x0115 : 0x0114,
            ((pos & 0xffff) << 16) | code,
            hwnd,
          ]);
        };
        if (message === 0x0201 || message === 0x0203) {
          this.focusWindow = hwnd;
          if (point >= geometry.start && point < geometry.start + geometry.thumb) {
            this.scrollbarDrag = { hwnd, offset: point - geometry.start, previousCapture: this.captureWindow };
            this.captureWindow = hwnd;
            state.trackPos = state.pos;
            return { eax: 0 };
          }
          const code =
            point < geometry.arrow ? 0 : point >= length - geometry.arrow ? 1 : point < geometry.start ? 2 : 3;
          if ((code === 0 && state.disabled & 1) || (code === 1 && state.disabled & 2)) return { eax: 0 };
          return notifyScroll(code);
        }
        if (message === 0x0200 && this.scrollbarDrag?.hwnd === hwnd) {
          const offset = Math.max(0, Math.min(geometry.travel, point - this.scrollbarDrag.offset - geometry.arrow));
          state.trackPos =
            state.min + Math.round((offset * (scrollbarLimit(state) - state.min)) / Math.max(1, geometry.travel));
          return notifyScroll(5, state.trackPos); // SB_THUMBTRACK
        }
        if (message === 0x0202) {
          if (this.scrollbarDrag?.hwnd === hwnd) {
            this.captureWindow = this.scrollbarDrag.previousCapture;
            this.scrollbarDrag = null;
            return notifyScroll(4, state.trackPos); // SB_THUMBPOSITION
          }
          return notifyScroll(8); // SB_ENDSCROLL
        }
        if (message === 0x0100) {
          const code = new Map([
            [0x26, 0],
            [0x25, 0],
            [0x28, 1],
            [0x27, 1],
            [0x21, 2],
            [0x22, 3],
            [0x24, 6],
            [0x23, 7],
          ]).get(wParam);
          if (code !== undefined) return notifyScroll(code);
        }
        return { eax: 0 };
      }
      if (message === 0x000f && this.isOwnerDrawControl(hwnd) && this.beginOwnerDraw(call, hwnd)) {
        return { eax: 0 };
      }
      const notify = (code: number, controlMessage = 0x0111, value = id & 0xffff): Win32Result =>
        parent
          ? (this as unknown as User32MessageLoopBridge).sendMessage(call, [
              parent,
              controlMessage,
              controlMessage === 0x0111 ? (((code & 0xffff) << 16) | value) >>> 0 : value >>> 0,
              hwnd,
            ])
          : { eax: 0 };

      if (className === 'button' && message === 0x0201) {
        // WM_LBUTTONDOWN
        const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
        if ((style & 0x0800_0000) !== 0) return { eax: 0 }; // WS_DISABLED
        this.focusWindow = hwnd;
        this.captureWindow = hwnd;
        this.pressedButton = hwnd;
        return { eax: 0 };
      }

      // Native Edit/ComboBox/ListBox controls gain keyboard focus on mouse down.
      // RA2 NewEdit uses physical class name ListBox; omitting it sends subsequent
      // WM_CHAR back to the dialog, making player names appear uneditable.
      if (message === 0x0201 && (className === 'edit' || className === 'combobox' || className === 'listbox')) {
        this.focusWindow = hwnd;
      }
      if (className === 'listbox' && message === 0x0115) {
        // WM_VSCROLL
        const items = this.controlItems.get(hwnd) ?? [];
        const height = this.controlItemHeights.get(hwnd) ?? 16;
        const rect = this.windowRects.get(hwnd);
        const page = Math.max(1, Math.floor((rect?.height ?? 0) / Math.max(1, height)));
        const maxTop = Math.max(0, items.length - 1);
        const top = this.listboxTopIndices.get(hwnd) ?? 0;
        let next = top;
        switch (wParam & 0xffff) {
          case 0:
            next = top - 1;
            break; // SB_LINEUP
          case 1:
            next = top + 1;
            break; // SB_LINEDOWN
          case 2:
            next = top - page;
            break; // SB_PAGEUP
          case 3:
            next = top + page;
            break; // SB_PAGEDOWN
          case 4:
          case 5:
            next = (wParam >>> 16) & 0xffff;
            break; // SB_THUMBPOSITION / SB_THUMBTRACK
          case 6:
            next = 0;
            break; // SB_TOP
          case 7:
            next = maxTop;
            break; // SB_BOTTOM
          default:
            return { eax: 0 }; // SB_ENDSCROLL and similar notifications need no state change.
        }
        next = Math.max(0, Math.min(maxTop, next));
        if (next !== top) {
          this.listboxTopIndices.set(hwnd, next);
          this.invalidateWindow(hwnd);
        }
        // Real USER32 forwards WM_VSCROLL to the parent for LBS_NOTIFY lists,
        // with the list HWND in lParam.
        if (parent && ((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 1) !== 0) {
          return (this as unknown as User32MessageLoopBridge).sendMessage(call, [parent, 0x0115, wParam >>> 0, hwnd]);
        }
        return { eax: 0 };
      }
      if (className === 'listbox' && message === 0x020a) {
        // WM_MOUSEWHEEL
        const items = this.controlItems.get(hwnd) ?? [];
        const maxTop = Math.max(0, items.length - 1);
        const top = this.listboxTopIndices.get(hwnd) ?? 0;
        // Scroll three rows per WHEEL_DELTA=120 notch; negative values scroll downward.
        const delta = Math.trunc((((wParam >> 16) << 16) >> 16) / 120) * 3;
        const next = Math.max(0, Math.min(maxTop, top - delta));
        if (next !== top) {
          this.listboxTopIndices.set(hwnd, next);
          this.invalidateWindow(hwnd);
        }
        // USER32 forwards unconsumed wheel messages to the parent.
        if (parent) {
          return (this as unknown as User32MessageLoopBridge).sendMessage(call, [
            parent,
            0x020a,
            wParam >>> 0,
            lParam >>> 0,
          ]);
        }
        return { eax: 0 };
      }
      if (className === 'edit' && message === 0x0102) {
        // WM_CHAR
        const before = this.windowTexts.get(hwnd) ?? '';
        const result = this.defaultControlProc(hwnd, message, wParam, lParam);
        if ((this.windowTexts.get(hwnd) ?? '') !== before) return notify(0x0300); // EN_CHANGE
        return { eax: result };
      }
      if (className === 'combobox' && message === 0x0202) {
        const combo = this.initializeComboState(hwnd);
        const clientY = lParam >> 16;
        const selectionTop = combo.selectionHeight + 4;
        if (combo.dropped && clientY >= selectionTop) {
          const items = this.controlItems.get(hwnd) ?? [];
          const index = Math.floor((clientY - selectionTop) / Math.max(1, combo.itemHeight));
          this.setComboDropped(hwnd, false);
          if (this.captureWindow === hwnd) this.captureWindow = 0;
          if (index >= 0 && index < items.length) {
            if (shimTraceEnabled('VM_TRACE_GADGET')) {
              console.log(
                `🧭 ComboBox select hwnd=0x${hwnd.toString(16)} index=${index} text=${JSON.stringify(items[index]?.text ?? '')}`,
              );
            }
            this.controlSelections.set(hwnd, index);
            this.invalidateWindow(hwnd);
            return notify(1); // CBN_SELCHANGE
          }
        } else if (clientY < selectionTop && this.isComboDropButtonHit(hwnd, lParam)) {
          const dropped = !combo.dropped;
          this.setComboDropped(hwnd, dropped);
          this.focusWindow = hwnd;
          this.captureWindow = dropped ? hwnd : 0;
          return notify(dropped ? 7 : 8); // CBN_DROPDOWN / CBN_CLOSEUP
        }
        this.invalidateWindow(hwnd);
        return { eax: 0 };
      }
      // ListBox selects on down; custom procedures may handle down and forward only up.
      // Changing selection and notifying again on up would reenter list reconstruction twice.
      if (className === 'listbox' && message === 0x0201) {
        const items = this.controlItems.get(hwnd) ?? [];
        const index = Math.floor((lParam >> 16) / (this.controlItemHeights.get(hwnd) ?? 16));
        if (index >= 0 && index < items.length && this.controlSelections.get(hwnd) !== index) {
          this.controlSelections.set(hwnd, index);
          this.invalidateWindow(hwnd);
          if (((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 1) !== 0) return notify(1); // LBS_NOTIFY / LBN_SELCHANGE
        }
      }
      if (className === 'msctls_trackbar32' && (message === 0x0200 || message === 0x0201 || message === 0x0202)) {
        const dragging = message !== 0x0200 || (wParam & 1) !== 0;
        if (dragging) {
          const state = this.trackbarStates.get(hwnd) ?? { min: 0, max: 100, pos: 0 };
          this.trackbarStates.set(hwnd, state);
          const width = Math.max(1, (this.windowRects.get(hwnd)?.width ?? 1) - 1);
          const x = Math.max(0, Math.min(width, (lParam << 16) >> 16));
          state.pos = state.min + Math.round((x * (state.max - state.min)) / width);
          this.invalidateWindow(hwnd);
          if (message === 0x0202) return notify(4, 0x0114, ((state.pos & 0xffff) << 16) | 4);
        }
        return { eax: 0 };
      }
      if (message === 0x0202 && className === 'button') {
        const x = (lParam << 16) >> 16;
        const y = lParam >> 16;
        const rect = this.windowRects.get(hwnd);
        const clicked = this.pressedButton === hwnd && !!rect && x >= 0 && y >= 0 && x < rect.width && y < rect.height;
        if (this.captureWindow === hwnd) this.captureWindow = 0;
        if (this.pressedButton === hwnd) this.pressedButton = 0;
        if (!clicked) return { eax: 0 };
        this.activateButton(hwnd);
        return notify(0); // BN_CLICKED
      }
      if (message === 0x00f5 && className === 'button') {
        // BM_CLICK
        const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
        if ((style & 0x08000000) !== 0) return { eax: 0 }; // disabled
        this.activateButton(hwnd);
        return notify(0); // BN_CLICKED
      }
      return { eax: this.defaultControlProc(hwnd, message, wParam, lParam) };
    }

    protected isOwnerDrawControl(hwnd: number): boolean {
      const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
      const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
      if (className === 'button') return (style & 0x0f) === 0x0b; // BS_OWNERDRAW
      if (className === 'listbox' || className === 'combobox') {
        return (style & 0x30) !== 0; // LBS/CBS_OWNERDRAWFIXED|VARIABLE
      }
      return false;
    }

    /** Default procedures synchronously send WM_DRAWITEM to parents for built-in owner-drawn controls. */
    protected beginOwnerDraw(call: Win32Call, hwnd: number): boolean {
      if (this.readU32(OWNER_DRAW_ACTIVE) || !this.isActiveShellWindow(hwnd)) return false;
      const parent = this.windowParents.get(hwnd) ?? 0;
      const callback = this.windows.get(parent) ?? 0;
      const rect = this.windowRects.get(hwnd);
      if (!parent || !callback || !rect || rect.width <= 0 || rect.height <= 0) return false;
      if (shimTraceEnabled('VM_TRACE_PAINT') && this.paintTraceCount < 50) {
        this.paintTraceCount++;
        console.log(
          `🎨 WM_DRAWITEM hwnd=0x${hwnd.toString(16)} parent=0x${parent.toString(16)} proc=0x${callback.toString(16)}`,
        );
      }
      const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
      const items = this.controlItems.get(hwnd) ?? [];
      const itemHeight = Math.max(1, this.controlItemHeights.get(hwnd) ?? 16);
      const selected = this.controlSelections.get(hwnd) ?? -1;
      const entries =
        className === 'button'
          ? [{ id: 0, top: 0, bottom: rect.height, data: 0 }]
          : items.slice(0, Math.ceil(rect.height / itemHeight)).map((item, index) => ({
              id: index,
              top: index * itemHeight,
              bottom: Math.min(rect.height, (index + 1) * itemHeight),
              data: item.data,
            }));
      if (!entries.length) return false;

      let dc = this.ownerDrawDcs.get(hwnd) ?? 0;
      if (!dc) {
        const origin = this.screenOrigin(hwnd);
        dc = this.createGdiDc(this.primarySurface, origin.x, origin.y);
        this.ownerDrawDcs.set(hwnd, dc);
      }
      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { trampoline } = frame;
      const structs = trampoline + CALLBACK_STRIDE - entries.length * 48;
      const controlId = this.controlIds.get(hwnd) ?? 0;
      const controlType = className === 'button' ? 4 : className === 'combobox' ? 3 : 2;
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55, 0x89, 0xe5);
      entries.forEach((_entry, index) => {
        push(structs + index * 48);
        push(controlId);
        push(0x002b); // WM_DRAWITEM
        push(parent);
        code.push(0xb8);
        emit32(callback);
        code.push(0xff, 0xd0, 0x89, 0xec);
      });
      code.push(0x31, 0xc0); // Default procedure returns 0.
      code.push(0x89, 0xec, 0x5d);
      code.push(0xc7, 0x05);
      emit32(OWNER_DRAW_ACTIVE);
      emit32(0);
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      if (trampoline + code.length > structs) {
        throw new Error(`WM_DRAWITEM 桥超出槽位: code=${code.length} entries=${entries.length}`);
      }
      // Validate combined code and DRAWITEMSTRUCT sizes before writing guest memory; huge lists
      // may place structs inside a preceding active slot, so post-write bounds checks are too late.
      entries.forEach((entry, index) => {
        const pointer = structs + index * 48;
        this.writeU32(pointer, controlType);
        this.writeU32(pointer + 4, controlId);
        this.writeU32(pointer + 8, entry.id);
        this.writeU32(pointer + 12, 1); // ODA_DRAWENTIRE
        this.writeU32(pointer + 16, entry.id === selected ? 1 : 0); // ODS_SELECTED
        this.writeU32(pointer + 20, hwnd);
        this.writeU32(pointer + 24, dc);
        this.writeRect(pointer + 28, 0, entry.top, rect.width, entry.bottom);
        this.writeU32(pointer + 44, entry.data);
      });
      this.writeU32(OWNER_DRAW_ACTIVE, 1);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return true;
    }

    /** 从当前 shell 的静态全屏 surface 恢复一个被临时下拉层覆盖的区域。 */
    protected restoreShellRectFromBackground(surface: SurfaceState, rect: [number, number, number, number]): boolean {
      const left = Math.max(0, rect[0]);
      const top = Math.max(0, rect[1]);
      const right = Math.min(surface.width, rect[2]);
      const bottom = Math.min(surface.height, rect[3]);
      if (surface.bpp !== 16 || right <= left || bottom <= top) return false;
      const background = [...this.surfaces.values()]
        .filter(
          (candidate) =>
            candidate.object !== surface.object &&
            candidate.bpp === 16 &&
            candidate.width === surface.width &&
            candidate.height === surface.height &&
            candidate.caps === 0,
        )
        .sort((leftSurface, rightSurface) => rightSurface.lastDrawSerial - leftSurface.lastDrawSerial)[0];
      if (!background) return false;
      const pixels = this.memory.read_memory(background.pixels, background.pitch * background.height);
      const rowBytes = (right - left) * 2;
      for (let y = top; y < bottom; y++) {
        const source = y * background.pitch + left * 2;
        this.memory.write_memory(
          pixels.subarray(source, source + rowBytes),
          surface.pixels + y * surface.pitch + left * 2,
        );
      }
      return true;
    }

    protected requiresRgbaComposite(): boolean {
      // Menus retain existing composition; GPU direct upload must not discard country/map scrollbars.
      if (super.requiresRgbaComposite() || this.campaignMenu() !== undefined) return true;
      return this.windowZOrder.some(
        (hwnd) => this.windowClassNames.get(hwnd)?.toLowerCase() === 'scrollbar' && this.isWindowVisible(hwnd),
      );
    }

    protected compositeWindowControls(rgba: Uint8Array, width: number, height: number): void {
      this.repairHiddenCampaignListBorder(rgba, width, height);
      for (const hwnd of this.windowZOrder) {
        if (this.windowClassNames.get(hwnd)?.toLowerCase() !== 'scrollbar' || !this.isWindowVisible(hwnd)) continue;
        const state = this.scrollbarState(hwnd);
        const rect = this.screenRect(hwnd);
        // Host-drawn controls must obey the same sibling Z order as native dialog painting.
        // A later sibling of any ancestor can cover this control, even if its own parent is visible.
        const occluders: ReturnType<typeof this.screenRect>[] = [];
        const visited = new Set<number>();
        for (
          let ancestor = hwnd;
          ancestor && !visited.has(ancestor);
          ancestor = this.windowParents.get(ancestor) ?? 0
        ) {
          visited.add(ancestor);
          const parent = this.windowParents.get(ancestor) ?? 0;
          for (const candidate of this.windowZOrder.slice(this.windowZOrder.indexOf(ancestor) + 1)) {
            if ((this.windowParents.get(candidate) ?? 0) !== parent || !this.isWindowVisible(candidate)) continue;
            const cover = this.screenRect(candidate);
            if (
              cover.x < rect.x + rect.width &&
              cover.x + cover.width > rect.x &&
              cover.y < rect.y + rect.height &&
              cover.y + cover.height > rect.y
            )
              occluders.push(cover);
          }
        }
        const vertical = ((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 1) !== 0;
        const length = vertical ? rect.height : rect.width;
        const breadth = vertical ? rect.width : rect.height;
        const g = scrollbarGeometry(state, length, breadth);
        // Native controls use dark backgrounds, red borders, and bright arrows matching client-area colors.
        const fill = (across: number, along: number, w: number, h: number, color: number[]) => {
          for (let a = along; a < along + h; a++)
            for (let b = across; b < across + w; b++) {
              const x = rect.x + (vertical ? b : a);
              const y = rect.y + (vertical ? a : b);
              if (x < 0 || y < 0 || x >= width || y >= height) continue;
              if (
                occluders.some(
                  (cover) => x >= cover.x && x < cover.x + cover.width && y >= cover.y && y < cover.y + cover.height,
                )
              )
                continue;
              const offset = (y * width + x) * 4;
              rgba[offset] = color[0]!;
              rgba[offset + 1] = color[1]!;
              rgba[offset + 2] = color[2]!;
              rgba[offset + 3] = 255;
            }
        };
        const border = [180, 0, 0],
          dark = [28, 8, 8],
          light = [255, 210, 0];
        fill(0, 0, breadth, length, border);
        fill(1, 1, breadth - 2, length - 2, dark);
        for (const along of [0, length - g.arrow, g.start]) {
          const size = along === g.start ? g.thumb : g.arrow;
          fill(1, along + 1, breadth - 2, size - 2, border);
          fill(3, along + 3, breadth - 6, size - 6, [65, 12, 12]);
        }
        const center = Math.floor(breadth / 2);
        const radius = Math.max(1, Math.floor(Math.min(breadth, g.arrow) / 4));
        for (let row = 0; row < radius; row++) {
          fill(center - row, (Math.floor(g.arrow / 2) - radius / 2 + row) | 0, row * 2 + 1, 1, light);
          fill(center - row, (length - Math.floor(g.arrow / 2) + radius / 2 - row) | 0, row * 2 + 1, 1, light);
        }
      }
    }

    protected scrollbarState(hwnd: number): ScrollbarState {
      let state = this.scrollbarStates.get(hwnd);
      if (!state) {
        state = { min: 0, max: 100, page: 0, pos: 0, trackPos: 0, disabled: 0 };
        this.scrollbarStates.set(hwnd, state);
      }
      return state;
    }

    protected scrollbarOwner(hwnd: number): number {
      if (!this.gameProfile.shell?.siblingScrollbarOwner) return 0;
      const bar = this.screenRect(hwnd);
      const parent = this.windowParents.get(hwnd);
      return (
        this.windowZOrder.find((candidate) => {
          if (
            !['listbox', 'combodropwin'].includes(this.windowClassNames.get(candidate)?.toLowerCase() ?? '') ||
            this.windowParents.get(candidate) !== parent ||
            !this.isWindowVisible(candidate)
          )
            return false;
          const list = this.screenRect(candidate);
          return list.y === bar.y && list.height === bar.height && Math.abs(list.x + list.width - bar.x) <= 2;
        }) ?? 0
      );
    }

    /**
     * Campaign save ListBoxes are created with WS_VISIBLE and hidden after initialization, leaving native owner-drawn black backgrounds/1px red borders in primary. The fullscreen caps=0 surface supplies the current page's control-free background: use it only for residual pure-black pixels, preserving existing gray sidebar content, and repair four red edges from adjacent outside pixels.
     */
    protected repairHiddenCampaignListBorder(rgba: Uint8Array, width: number, height: number): void {
      const menu = this.campaignMenu();
      if (!menu) return;
      const list = [...this.controlIds].find(
        ([hwnd, id]) =>
          id === menu.hiddenListControlId &&
          this.windowClassNames.get(hwnd)?.toLowerCase() === 'listbox' &&
          !this.isWindowVisible(hwnd),
      )?.[0];
      if (!list) return;
      const rect = this.screenRect(list);
      const left = Math.max(0, rect.x);
      const top = Math.max(0, rect.y);
      const right = Math.min(width, rect.x + rect.width);
      const bottom = Math.min(height, rect.y + rect.height);
      if (right <= left || bottom <= top) return;
      const background = [...this.surfaces.values()]
        .filter(
          (surface) =>
            surface.object !== this.primarySurface &&
            surface.bpp === 16 &&
            surface.width === width &&
            surface.height === height &&
            surface.caps === 0,
        )
        .sort((leftSurface, rightSurface) => rightSurface.lastDrawSerial - leftSurface.lastDrawSerial)[0];
      if (background) {
        const pixels = this.memory.read_memory(background.pixels, background.pitch * background.height);
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const target = (y * width + x) * 4;
            if (rgba[target]! > 8 || rgba[target + 1]! > 8 || rgba[target + 2]! > 8) continue;
            const source = y * background.pitch + x * 2;
            const pixel = pixels[source]! | (pixels[source + 1]! << 8);
            rgba[target] = (((pixel >>> 11) & 0x1f) * 255) / 31;
            rgba[target + 1] = (((pixel >>> 5) & 0x3f) * 255) / 63;
            rgba[target + 2] = ((pixel & 0x1f) * 255) / 31;
            rgba[target + 3] = 0xff;
          }
        }
      }
      const copyPixel = (toX: number, toY: number, fromX: number, fromY: number): void => {
        if (
          toX < 0 ||
          toX >= width ||
          toY < 0 ||
          toY >= height ||
          fromX < 0 ||
          fromX >= width ||
          fromY < 0 ||
          fromY >= height
        )
          return;
        const to = (toY * width + toX) * 4;
        const from = (fromY * width + fromX) * 4;
        rgba.copyWithin(to, from, from + 4);
      };
      for (let x = left; x < right; x++) {
        copyPixel(x, top, x, top - 1);
        copyPixel(x, bottom - 1, x, bottom);
      }
      for (let y = top; y < bottom; y++) {
        copyPixel(left, y, left - 1, y);
        copyPixel(right - 1, y, right, y);
      }
    }

    protected placeWindow(hwnd: number, insertAfter: number): void {
      const previous = this.windowZOrder.indexOf(hwnd);
      if (previous >= 0) this.windowZOrder.splice(previous, 1);
      if (insertAfter === 1) {
        // HWND_BOTTOM
        this.windowZOrder.unshift(hwnd);
        return;
      }
      if (!insertAfter || insertAfter === 0xffff_ffff || insertAfter === 0xffff_fffe) {
        this.windowZOrder.push(hwnd); // HWND_TOP/TOPMOST/NOTOPMOST
        return;
      }
      const anchor = this.windowZOrder.indexOf(insertAfter);
      this.windowZOrder.splice(anchor < 0 ? this.windowZOrder.length : anchor + 1, 0, hwnd);
    }

    /**
     * UpdateWindow and repainting MoveWindow are synchronous paint boundaries. The game's inner PeekMessage actively removes system messages, so merely queueing them would leave owner-drawn buttons unexecuted forever.
     */
    protected paintWindow(call: Win32Call, hwnd: number): Win32Result {
      this.invalidateWindow(hwnd);
      // UpdateWindow/MoveWindow do not visibly paint hidden controls. Options templates contain
      // reserved hidden buttons; forcing WM_PAINT onto them writes unlocalized
      // GUI:* resource keys over nearby labels, appearing as random garbage.
      if (!this.isWindowVisible(hwnd)) {
        this.invalidatedWindows.delete(hwnd);
        return { eax: 1 };
      }
      if (this.discardInactivePaint(hwnd)) return { eax: 1 };
      // RA2 owner-drawn shell controls lock DirectDraw directly during WM_PAINT,
      // bypassing BeginPaint. Real USER32 validates after synchronous UpdateWindow returns.
      // Retaining invalid forever makes invalidateWindow swallow later MoveWindow/shutter-animation redraws
      // as duplicates, freezing presentation at initial 640x480 coordinates.
      if (this.windows.get(hwnd)) {
        return (this as unknown as User32MessageLoopBridge).sendMessage(call, [hwnd, 0x000f, 0, 0]);
      }
      this.defaultControlProc(hwnd, 0x000f, 0, 0);
      this.invalidatedWindows.delete(hwnd);
      return { eax: 1 };
    }

    /** EnumChildWindows serially invokes native enumeration callbacks through one guest bridge. */
    protected beginEnumChildWindows(call: Win32Call, parent: number, callback: number, param: number): boolean {
      if (!callback) return false;
      const children = [...this.windowParents]
        .filter(([, candidateParent]) => candidateParent === parent)
        .map(([hwnd]) => hwnd);
      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { trampoline } = frame;
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp, esp
      const stopBranches: number[] = [];
      for (const child of children) {
        push(param);
        push(child);
        code.push(0xb8);
        emit32(callback);
        code.push(0xff, 0xd0, 0x89, 0xec); // call eax; mov esp, ebp
        code.push(0x85, 0xc0, 0x0f, 0x84); // test eax,eax; jz cleanup
        stopBranches.push(code.length);
        emit32(0);
      }
      code.push(0xb8);
      emit32(1);
      const cleanup = code.length;
      code.push(0x89, 0xec, 0x5d); // mov esp, ebp; pop ebp
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      for (const branch of stopBranches) {
        const relative = cleanup - (branch + 4);
        code[branch] = relative & 0xff;
        code[branch + 1] = (relative >>> 8) & 0xff;
        code[branch + 2] = (relative >>> 16) & 0xff;
        code[branch + 3] = relative >>> 24;
      }
      if (code.length > CALLBACK_STRIDE) throw new Error(`EnumChildWindows 桥超出槽位: ${code.length}`);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return true;
    }

    /** Share one guest bridge when a Win32 API synchronously sends multiple messages, such as EnableWindow. */
  };
}
