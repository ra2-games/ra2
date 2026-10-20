import type { MessageState, Win32Call, Win32Result } from '../win32';
import { HYPERCALL_THREAD_CURRENT, GUEST_CALLBACK_STRIDE as CALLBACK_STRIDE } from '../pe';
import { shimTraceEnabled, type Constructor, type GuestCallbackFrame } from './state';
import { withUser32Windowing } from './user32Windowing';

type User32WindowingChain = InstanceType<ReturnType<typeof withUser32Windowing>>;

export function withUser32MessageLoop<TBase extends Constructor<User32WindowingChain>>(Base: TBase) {
  return class extends Base {
    protected lastPointerDown: { hwnd: number; message: number; time: number; x: number; y: number } | null = null;
    /**
     * ComboDropWin may hide during WM_LBUTTONDOWN; retain the click target so later WM_LBUTTONUP cannot hit a sibling ComboBox beneath the popup.
     */
    protected hostPointerCapture = 0;
    /** Child hit by the latest synthesized WM_NCHITTEST; synthesize again only when the child changes. */
    protected lastHitTestChild = 0;
    protected sendMessageSequence(
      call: Win32Call,
      hwnd: number,
      messages: Array<{ message: number; wParam: number; lParam: number }>,
      forcedReturn: number,
    ): { eax: number } {
      const callback = this.windows.get(hwnd);
      if (callback === undefined) return { eax: 0 };
      if (!callback) {
        for (const message of messages) {
          this.dispatchDefaultControl(call, hwnd, message.message, message.wParam, message.lParam);
        }
        return { eax: forcedReturn };
      }

      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      const last = messages.at(-1)!;
      this.lastCallbackState = {
        hwnd,
        message: last.message,
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
      code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp,esp
      for (const message of messages) {
        push(message.lParam);
        push(message.wParam);
        push(message.message);
        push(hwnd);
        code.push(0xb8);
        emit32(callback);
        code.push(0xff, 0xd0); // call eax
        code.push(0x89, 0xec); // mov esp,ebp accommodates stdcall/cdecl.
      }
      code.push(0x89, 0xec, 0x5d); // mov esp,ebp; pop ebp
      code.push(0xb8);
      emit32(forcedReturn);
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      if (code.length > CALLBACK_STRIDE) throw new Error(`SendMessage 序列桥超出槽位: ${code.length}`);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return { eax: 0 };
    }

    protected sendMessage(
      call: Win32Call,
      args: number[],
      forcedReturn?: number,
      reservedFrame?: GuestCallbackFrame,
    ): { eax: number } {
      const hwnd = args[0] ?? 0;
      const message = args[1] ?? 0;
      const wParam = args[2] ?? 0;
      const lParam = args[3] ?? 0;
      const mci = this.mciWindows.get(hwnd);
      if (mci) {
        if (message === 0x0806 && !mci.playing) {
          // MCI_PLAY
          mci.playing = true;
          // Notify the owner when asynchronous MCIWnd playback finishes; the game's WndProc decides how state advances.
          this.queueMessage(0x03b9, 1, hwnd, mci.parent); // MM_MCINOTIFY / MCI_NOTIFY_SUCCESSFUL
        } else if (message === 0x0808) {
          // MCI_STOP
          mci.playing = false;
        } else if (message === 0x0010) {
          // WM_CLOSE
          this.mciWindows.delete(hwnd);
        }
        return { eax: 0 };
      }
      if (message === 0x000f && this.discardInactivePaint(hwnd)) return { eax: 0 };
      const callback = this.windows.get(hwnd);
      if (callback === undefined) return { eax: 0 };
      const selectionMessage = !!callback && this.syncListBoxSelectionMessage(hwnd, message, wParam, lParam);
      if (callback) this.observeControlTextMessage(hwnd, message, lParam);
      if (selectionMessage) this.invalidateWindow(hwnd);
      // Default system-control WndProcs belong to USER32 and have no guest callback address;
      // SendMessage must still execute them synchronously, preserving protocols such as CB_ADDSTRING/BM_SETCHECK.
      if (!callback) {
        const result = this.dispatchDefaultControl(call, hwnd, message, wParam, lParam);
        return forcedReturn === undefined ? result : { eax: forcedReturn };
      }
      // Synchronous dispatch: real SendMessageA enters WndProc directly. Rewrite return addresses with the message-pump
      // trampoline; WndProc's EAX naturally becomes SendMessageA's result.
      if (message === 0x000f) this.pendingPaintValidations.add(hwnd);
      const originalReturn = this.readU32(call.stack);
      const frame = reservedFrame ?? this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      this.lastCallbackState = { hwnd, message, callback, callStack: call.stack, originalReturn, trampoline, depth };
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55); // push ebp
      code.push(0x89, 0xe5); // mov ebp, esp saves the pre-callback stack top.
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      push(lParam);
      push(wParam);
      push(message);
      push(hwnd);
      code.push(0xb8);
      emit32(callback);
      code.push(0xff, 0xd0); // call eax
      code.push(0x89, 0xec); // mov esp, ebp accommodates stdcall/cdecl callback cleanup differences.
      code.push(0x5d); // pop ebp
      if (forcedReturn !== undefined) {
        code.push(0xb8);
        emit32(forcedReturn); // API results such as ShowWindow are independent of WndProc results.
      }
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return { eax: 0 };
    }

    /**
     * RA2 shell inner loops call PeekMessageA without necessarily calling DispatchMessageA; one browser event batch may already contain move/down/up. Chain the batch into a guest bridge that invokes native control WndProcs in order. After all callbacks, force PeekMessageA to return FALSE; the last WndProc EAX must not masquerade as a retrieved MSG.
     */
    protected dispatchPendingHostInput(call: Win32Call): Win32Result {
      const pending = this.pendingHostDispatches.splice(0, 12);
      const dispatches: Array<MessageState & { callback: number }> = [];
      const notifyParent = (message: MessageState, notification: number, controlMessage = 0x0111) => {
        const parent = this.windowParents.get(message.hwnd) ?? 0;
        const callback = this.windows.get(parent) ?? 0;
        if (!parent || !callback) return;
        dispatches.push({
          ...message,
          hwnd: parent,
          message: controlMessage,
          wParam:
            controlMessage === 0x0111
              ? (((notification & 0xffff) << 16) | ((this.controlIds.get(message.hwnd) ?? 0) & 0xffff)) >>> 0
              : notification >>> 0,
          lParam: message.hwnd,
          callback,
        });
      };
      for (const message of pending) {
        let hwnd = message.hwnd;
        let callback = this.windows.get(hwnd) ?? 0;
        let delivered = message;
        if (!this.isActiveShellWindow(hwnd)) continue;
        const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
        this.hostInputTrace.push({
          phase: 'dispatch',
          hwnd,
          message: message.message,
          callback,
          className,
          lParam: message.lParam,
        });
        if (this.hostInputTrace.length > 24) this.hostInputTrace.splice(0, this.hostInputTrace.length - 24);
        if (!callback) {
          if (message.message === 0x0201 && (className === 'edit' || className === 'combobox')) {
            this.focusWindow = hwnd;
          }
          if (className === 'combobox' && message.message === 0x0202) {
            const combo = this.initializeComboState(hwnd);
            const clientY = message.lParam >> 16;
            const selectionTop = combo.selectionHeight + 4;
            if (combo.dropped && clientY >= selectionTop) {
              const items = this.controlItems.get(hwnd) ?? [];
              const index = Math.floor((clientY - selectionTop) / Math.max(1, combo.itemHeight));
              if (index >= 0 && index < items.length) {
                this.controlSelections.set(hwnd, index);
                notifyParent(message, 1); // CBN_SELCHANGE
              }
              this.setComboDropped(hwnd, false);
              if (this.captureWindow === hwnd) this.captureWindow = 0;
            } else if (clientY < selectionTop && this.isComboDropButtonHit(hwnd, message.lParam)) {
              const dropped = !combo.dropped;
              this.setComboDropped(hwnd, dropped);
              this.focusWindow = hwnd;
              this.captureWindow = dropped ? hwnd : 0;
            }
            continue;
          }
          if (className === 'listbox' && message.message === 0x0202) {
            const items = this.controlItems.get(hwnd) ?? [];
            const index = Math.floor((message.lParam >> 16) / (this.controlItemHeights.get(hwnd) ?? 16));
            if (index >= 0 && index < items.length) {
              this.controlSelections.set(hwnd, index);
              notifyParent(message, 1); // LBN_SELCHANGE
              this.invalidateWindow(hwnd);
            }
            continue;
          }
          if (
            className === 'msctls_trackbar32' &&
            (message.message === 0x0200 || message.message === 0x0201 || message.message === 0x0202)
          ) {
            const dragging = message.message !== 0x0200 || (message.wParam & 1) !== 0;
            if (dragging) {
              const state = this.trackbarStates.get(hwnd) ?? { min: 0, max: 100, pos: 0 };
              this.trackbarStates.set(hwnd, state);
              const width = Math.max(1, (this.windowRects.get(hwnd)?.width ?? 1) - 1);
              const x = Math.max(0, Math.min(width, (message.lParam << 16) >> 16));
              state.pos = state.min + Math.round((x * (state.max - state.min)) / width);
              this.invalidateWindow(hwnd);
              if (message.message === 0x0202) notifyParent(message, ((state.pos & 0xffff) << 16) | 4, 0x0114);
            }
            continue;
          }
          if (className === 'button' && message.message === 0x0201) {
            const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
            if ((style & 0x0800_0000) === 0) {
              this.focusWindow = hwnd;
              this.captureWindow = hwnd;
              this.pressedButton = hwnd;
            }
            continue;
          }
          if (className === 'button' && message.message === 0x0202) {
            const x = (message.lParam << 16) >> 16;
            const y = message.lParam >> 16;
            const rect = this.windowRects.get(hwnd);
            const clicked =
              this.pressedButton === hwnd && !!rect && x >= 0 && y >= 0 && x < rect.width && y < rect.height;
            if (this.captureWindow === hwnd) this.captureWindow = 0;
            if (this.pressedButton === hwnd) this.pressedButton = 0;
            if (!clicked) continue;
            this.activateButton(hwnd);
            notifyParent(message, 0); // BN_CLICKED
            continue;
          }
          this.defaultControlProc(hwnd, message.message, message.wParam, message.lParam);
          continue;
        }
        if (callback) {
          dispatches.push({ ...delivered, hwnd, callback });
        }
      }
      this.hostInputDispatchCount += pending.length;
      if (!dispatches.length) return { eax: 0 };

      const originalReturn = this.readU32(call.stack);
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp,esp
      for (const message of dispatches) {
        push(message.lParam);
        push(message.wParam);
        push(message.message);
        push(message.hwnd);
        code.push(0xb8);
        emit32(message.callback);
        code.push(0xff, 0xd0); // call eax
        code.push(0x89, 0xec); // mov esp,ebp
      }
      code.push(0x31, 0xc0); // xor eax,eax makes PeekMessageA return FALSE.
      code.push(0x89, 0xec, 0x5d); // mov esp,ebp; pop ebp
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      if (code.length > CALLBACK_STRIDE) throw new Error(`鼠标批量桥超出槽位: ${code.length}`);
      const first = dispatches[0]!;
      this.lastCallbackState = {
        hwnd: first.hwnd,
        message: first.message,
        callback: first.callback,
        callStack: call.stack,
        originalReturn,
        trampoline,
        depth,
      };
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return { eax: 0 };
    }

    protected queueMessage(
      message: number,
      wParam: number,
      lParam: number,
      hwnd: number,
      generatedPaint = false,
    ): void {
      const queued: MessageState = {
        hwnd,
        message,
        wParam: wParam >>> 0,
        lParam: lParam >>> 0,
        time: this.clock.now() >>> 0,
        x: this.cursorX,
        y: this.cursorY,
      };
      if (generatedPaint) this.generatedPaintMessages.add(queued);
      this.enqueueMessage(this.messages, queued);
    }
    protected enqueueMessage(queue: MessageState[], message: MessageState): void {
      this.invalidateFastPeek();
      // Mouse movement may outpace the guest pump; retain only the latest WM_MOUSEMOVE.
      const tail = queue.at(-1);
      if (message.message === 0x0200 && tail?.message === message.message && tail.hwnd === message.hwnd) {
        queue[queue.length - 1] = message;
      } else {
        queue.push(message);
      }
    }
    protected markInputReady(): void {
      if (this.inputReady) return;
      // Intro MCIWnd runs an inner pump; the first message API after its closure belongs to the main pump.
      if (this.mciWindows.size) return;
      this.inputReady = true;
      // Real CreateWindow/ShowWindow first produce initial position and client-size messages.
      // The native WndProc uses them to establish the final Blt destination RECT at 0x4af0fc.
      this.queueMessage(0x0003, 0, 0, this.primaryWindow); // WM_MOVE: (0, 0)
      this.queueMessage(
        0x0005,
        0,
        ((this.displayHeight & 0xffff) << 16) | (this.displayWidth & 0xffff),
        this.primaryWindow,
      ); // WM_SIZE: SIZE_RESTORED, 800×600
      // Win32 top-level windows receive this on activation; native code uses it to enable input.
      this.queueMessage(0x001c, 1, 0, this.primaryWindow); // WM_ACTIVATEAPP
      for (const message of this.pendingHostMessages.splice(0)) this.enqueueMessage(this.messages, message);
    }
    protected setTimer(args: number[]): number {
      const hwnd = args[0] ?? 0;
      const id = args[1] || 1;
      const interval = Math.max(10, args[2] || 10);
      if (shimTraceEnabled('VM_TRACE_TIMER'))
        console.log(
          `⏲️ SetTimer hwnd=0x${hwnd.toString(16)} id=${id} interval=${interval} callback=0x${(args[3] ?? 0).toString(16)}`,
        );
      this.timers.set(this.timerKey(hwnd, id), {
        hwnd,
        id,
        interval,
        callback: args[3] ?? 0,
        next: this.clock.now() + interval,
      });
      this.invalidateFastPeek();
      return id;
    }
    protected timerKey(hwnd: number, id: number): string {
      return `${hwnd >>> 0}:${id >>> 0}`;
    }
    private receiveProcessMessages(): void {
      const context = this.options.processContext;
      if (!context) return;
      const local = this.readU32(HYPERCALL_THREAD_CURRENT);
      context.kernel.ensureQueue(context.pid, local, () => this.invalidateFastPeek());
      for (const message of context.kernel.take(context.pid, local))
        this.queueMessage(message.message, message.wParam, message.lParam, 0);
    }
    protected peekMessage(args: number[]): boolean {
      this.receiveProcessMessages();
      const messagePtr = args[0] ?? 0;
      const hwndFilter = args[1] ?? 0;
      const min = args[2] ?? 0;
      const max = args[3] ?? 0;
      const remove = ((args[4] ?? 0) & 1) !== 0;
      this.enqueueDueMultimediaTimers(this.clock.now());
      const queued = this.findQueuedMessage(hwndFilter, min, max);
      if (queued >= 0 && messagePtr) {
        const message = this.messages[queued]!;
        this.applyQueuedInputState(message);
        this.writeMessage(messagePtr, message);
        if (remove) this.messages.splice(queued, 1);
        return true;
      }
      const now = this.clock.now();
      const timer = [...this.timers.values()].find(
        (candidate) =>
          candidate.next <= now &&
          (!hwndFilter || candidate.hwnd === hwndFilter) &&
          (!min || 0x0113 >= min) &&
          (!max || 0x0113 <= max),
      );
      if (!timer || !messagePtr) return false;
      this.wmTimerDispatchCount++;
      this.writeMessage(messagePtr, {
        hwnd: timer.hwnd,
        message: 0x0113,
        wParam: timer.id,
        lParam: timer.callback,
        time: now >>> 0,
        x: this.cursorX,
        y: this.cursorY,
      });
      if (remove) timer.next = now + timer.interval;
      return true;
    }
    protected peekTimerDelay(): number {
      const now = this.clock.now();
      let guestDelay = Number.POSITIVE_INFINITY;
      for (const timer of this.timers.values()) guestDelay = Math.min(guestDelay, timer.next - now);
      for (const timer of this.multimediaTimers.values()) guestDelay = Math.min(guestDelay, timer.next - now);
      if (!Number.isFinite(guestDelay)) return 0;
      const hostDelay = this.clock.toHostDelay(Math.max(0, guestDelay));
      // PeekMessage is nonblocking. Yield only for imminent 10/34ms UI timers;
      // a tooltip's 1s/10s timer must not sleep the battle loop on every empty peek.
      if (hostDelay > 34) return 0;
      return Math.max(1, Math.min(10, hostDelay));
    }
    protected getMessage(args: number[]): Win32Result {
      this.receiveProcessMessages();
      const messagePtr = args[0] ?? 0;
      const hwndFilter = args[1] ?? 0;
      const min = args[2] ?? 0;
      const max = args[3] ?? 0;
      this.enqueueDueMultimediaTimers(this.clock.now());
      const queued = this.findQueuedMessage(hwndFilter, min, max);
      if (queued >= 0 && messagePtr) {
        const message = this.messages.splice(queued, 1)[0]!;
        this.applyQueuedInputState(message);
        this.writeMessage(messagePtr, message);
        return { eax: message.message === 0x0012 ? 0 : 1 };
      }
      const now = this.clock.now();
      const timer = [...this.timers.values()].find(
        (candidate) =>
          (!hwndFilter || candidate.hwnd === hwndFilter) && (!min || 0x0113 >= min) && (!max || 0x0113 <= max),
      );
      if (!timer || !messagePtr) return { eax: 1, delayMs: this.clock.toHostDelay(50) };
      const delayMs = Math.max(0, timer.next - now);
      this.writeMessage(messagePtr, {
        hwnd: timer.hwnd,
        message: 0x0113,
        wParam: timer.id,
        lParam: timer.callback,
        time: (now + delayMs) >>> 0,
        x: this.cursorX,
        y: this.cursorY,
      });
      timer.next = now + delayMs + timer.interval;
      return { eax: 1, delayMs: this.clock.toHostDelay(delayMs) };
    }
    protected findQueuedMessage(hwnd: number, min: number, max: number): number {
      return this.messages.findIndex(
        (message) =>
          (!hwnd || message.hwnd === hwnd || message.message === 0x0012) &&
          (!min || message.message >= min) &&
          (!max || message.message <= max),
      );
    }
    /**
     * Win32 key state and queued messages advance on one timeline. Browser/Worker code may receive pointerup/keyup before the guest consumes WM_MOUSE*. Answering GetAsyncKeyState from current host state loses quick clicks or Ctrl+clicks. Restore each message's mouse/modifier state on dequeue and let subsequent messages clear it.
     */
    protected applyQueuedInputState(
      message: Pick<MessageState, 'message' | 'wParam'> & Partial<Pick<MessageState, 'lParam' | 'modifierKeyState'>>,
    ): void {
      if (message.message >= 0x0200 && message.message <= 0x020e) {
        const shift = (message.wParam & 0x0004) !== 0;
        const control = (message.wParam & 0x0008) !== 0;
        const snapshot = message.modifierKeyState ?? 0;
        this.keyStates.set(0x01, (message.wParam & 0x0001) !== 0); // VK_LBUTTON / MK_LBUTTON
        this.keyStates.set(0x02, (message.wParam & 0x0002) !== 0); // VK_RBUTTON / MK_RBUTTON
        this.keyStates.set(0x04, (message.wParam & 0x0010) !== 0); // VK_MBUTTON / MK_MBUTTON
        this.keyStates.set(0x10, shift); // VK_SHIFT / MK_SHIFT
        this.keyStates.set(0x11, control); // VK_CONTROL / MK_CONTROL
        this.keyStates.set(0xa0, shift && ((snapshot & 0x03) === 0 || (snapshot & 0x01) !== 0));
        this.keyStates.set(0xa1, shift && (snapshot & 0x02) !== 0);
        this.keyStates.set(0xa2, control && ((snapshot & 0x0c) === 0 || (snapshot & 0x04) !== 0));
        this.keyStates.set(0xa3, control && (snapshot & 0x08) !== 0);
        return;
      }
      if (message.message === 0x0100 || message.message === 0x0104) {
        const vk = message.wParam & 0xff;
        this.keyStates.set(vk, true);
        if (vk === 0x11) {
          this.keyStates.set(((message.lParam ?? 0) & 0x0100_0000) !== 0 ? 0xa3 : 0xa2, true);
        }
        if (vk === 0x10) {
          this.keyStates.set((((message.lParam ?? 0) >>> 16) & 0xff) === 0x36 ? 0xa1 : 0xa0, true);
        }
      } else if (message.message === 0x0101 || message.message === 0x0105) {
        const vk = message.wParam & 0xff;
        this.keyStates.set(vk, false);
        if (vk === 0x11) {
          this.keyStates.set(((message.lParam ?? 0) & 0x0100_0000) !== 0 ? 0xa3 : 0xa2, false);
          this.keyStates.set(0x11, !!(this.keyStates.get(0xa2) || this.keyStates.get(0xa3)));
        }
        if (vk === 0x10) {
          this.keyStates.set((((message.lParam ?? 0) >>> 16) & 0xff) === 0x36 ? 0xa1 : 0xa0, false);
          this.keyStates.set(0x10, !!(this.keyStates.get(0xa0) || this.keyStates.get(0xa1)));
        }
      }
    }
    protected waitMessage(): Win32Result {
      const now = this.clock.now();
      this.enqueueDueMultimediaTimers(now);
      if (this.messages.length) return { eax: 1 };
      let delayMs = 50;
      for (const timer of this.timers.values()) delayMs = Math.min(delayMs, Math.max(1, timer.next - now));
      for (const timer of this.multimediaTimers.values()) {
        delayMs = Math.min(delayMs, Math.max(1, timer.next - now));
      }
      return { eax: 1, delayMs: this.clock.toHostDelay(delayMs) };
    }
    protected enqueueDueMultimediaTimers(now: number): void {
      for (const timer of [...this.multimediaTimers.values()]) {
        if (!timer.callback || timer.next > now) continue;
        const alreadyQueued = this.messages.some(
          (message) =>
            message.hwnd === 0 &&
            message.message === 0x0113 &&
            message.wParam === timer.id &&
            message.lParam === timer.callback,
        );
        if (!alreadyQueued) {
          if (shimTraceEnabled('VM_TRACE_TIMER'))
            console.log(`⏲️ 定时器触发 id=${timer.id} callback=0x${timer.callback.toString(16)} now=${now}`);
          this.queueMessage(0x0113, timer.id, timer.callback, 0);
        }
        if (timer.periodic) {
          // After page suspension, do not replay thousands of expired ticks.
          timer.next = now + timer.interval;
        } else {
          timer.next = Number.POSITIVE_INFINITY;
        }
      }
    }
    protected writeMessage(ptr: number, message: MessageState): void {
      this.zero(ptr, 28);
      this.writeU32(ptr, message.hwnd);
      this.writeU32(ptr + 4, message.message);
      this.writeU32(ptr + 8, message.wParam);
      this.writeU32(ptr + 12, message.lParam);
      this.writeU32(ptr + 16, message.time);
      this.writeU32(ptr + 20, message.x);
      this.writeU32(ptr + 24, message.y);
    }
    protected dispatchMessage(call: Win32Call, messagePtr: number): number {
      if (!messagePtr) return 0;
      const hwnd = this.readU32(messagePtr);
      const message = this.readU32(messagePtr + 4);
      const wParam = this.readU32(messagePtr + 8);
      const lParam = this.readU32(messagePtr + 12);
      if (message === 0x000f && this.discardInactivePaint(hwnd)) return 0;
      // The guest may inspect more queued messages before Dispatch; key-state queries inside WndProc must match
      // the current MSG rather than later physical keyup state. RA2 force attack relies on this order.
      this.applyQueuedInputState({ message, wParam });
      // Standard controls clear update regions via BeginPaint, but RA2 custom controls write DirectDraw directly.
      // Treat dequeued WM_PAINT as this cycle's validation boundary so later layout
      // or animation invalidations can generate another WM_PAINT instead of being coalesced forever.
      const multimediaTimer = message === 0x0113 && hwnd === 0 ? this.multimediaTimers.get(wParam) : undefined;
      const callback =
        multimediaTimer?.callback === lParam
          ? multimediaTimer.callback
          : message === 0x0113 && lParam
            ? lParam
            : (this.windows.get(hwnd) ?? 0);
      if (!callback) {
        const result = this.dispatchDefaultControl(call, hwnd, message, wParam, lParam).eax;
        if (message === 0x000f) this.invalidatedWindows.delete(hwnd);
        return result;
      }
      if (message === 0x000f) this.pendingPaintValidations.add(hwnd);

      const callbackArgs =
        multimediaTimer?.callback === lParam
          ? [multimediaTimer.id, 0, multimediaTimer.user, 0, 0]
          : message === 0x0113 && lParam
            ? [hwnd, message, wParam, this.clock.now() >>> 0]
            : [hwnd, message, wParam, lParam];
      if (multimediaTimer && !multimediaTimer.periodic) this.multimediaTimers.delete(multimediaTimer.id);

      const originalReturn = this.readU32(call.stack);
      // Callbacks may reenter the message pump; each level needs an independent bridge to preserve outer return addresses.
      const frame = this.reserveGuestCallback();
      const { depth, trampoline } = frame;
      this.lastCallbackState = { hwnd, message, callback, callStack: call.stack, originalReturn, trampoline, depth };
      const code: number[] = [];
      const emit32 = (value: number) => {
        code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      code.push(0x55); // push ebp
      code.push(0x89, 0xe5); // mov ebp, esp saves the pre-callback stack top.
      const push = (value: number) => {
        code.push(0x68, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
      };
      for (let i = callbackArgs.length - 1; i >= 0; i--) push(callbackArgs[i]!);
      code.push(0xb8);
      emit32(callback);
      code.push(0xff, 0xd0); // call eax
      code.push(0x89, 0xec); // mov esp, ebp accommodates stdcall/cdecl callback cleanup differences.
      code.push(0x5d); // pop ebp
      this.appendGuestCallbackReturn(code, frame, originalReturn);
      this.memory.write_memory(code, trampoline);
      this.writeU32(call.stack, trampoline);
      return 0;
    }
    /** Browser input and host events enter native WndProc through one Win32 message queue. */
    getHostInputDispatchCount(): number {
      return this.hostInputDispatchCount;
    }

    /** false means host input was consumed directly and need not await guest dispatch, such as an up after popup closure. */
    postMessage(message: number, wParam = 0, lParam = 0, hwnd = this.primaryWindow): void | false {
      // Preserve the host message coordinates before converting them to a child-window client area.
      const inputX = (lParam << 16) >> 16;
      const inputY = lParam >> 16;
      if (message >= 0x0100 && message <= 0x0108) {
        this.lastHostKeyMessage = message;
        this.lastHostKeyVirtualKey = wParam & 0xff;
      }
      const globalModifier =
        this.gameProfile.shell?.globalModifierKeys &&
        message >= 0x0100 &&
        message <= 0x0108 &&
        [0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5].includes(wParam & 0xff);
      if (
        !globalModifier &&
        message >= 0x0100 &&
        message <= 0x0108 &&
        hwnd === this.primaryWindow &&
        this.focusWindow
      ) {
        if (this.isWindowTreeEnabled(this.focusWindow) && this.isWindowTreeVisible(this.focusWindow)) {
          hwnd = this.focusWindow;
        } else this.focusWindow = 0;
      }
      // Real Windows sends synchronous WM_NCHITTEST with screen coordinates to the hit window before WM_MOUSEMOVE.
      // Westwood menu dialogs use ChildWindowFromPointEx in this branch to track child enter/leave,
      // driving Campaign logo hover animation and sound. Sending only
      // WM_MOUSEMOVE never executes that branch.
      let hitTest: { hwnd: number; lParam: number } | null = null;
      let hostHitHwnd = 0;
      if (message >= 0x0200 && message <= 0x020e && hwnd === this.primaryWindow) {
        const screenX = (lParam << 16) >> 16;
        const screenY = lParam >> 16;
        if (message === 0x0201) this.hostPointerCapture = 0;
        const latchedTarget = message === 0x0202 ? this.hostPointerCapture : 0;
        if (latchedTarget) {
          this.hostPointerCapture = 0;
          if (!this.windows.has(latchedTarget) || !this.isActiveShellWindow(latchedTarget)) {
            // The popup disappeared during down; do not retarget this up to an underlying control,
            // but release host VK_LBUTTON synchronously so later input is not mistaken for dragging.
            this.applyQueuedInputState({ message, wParam });
            return false;
          }
        }
        if (this.captureWindow && !this.isWindowTreeEnabled(this.captureWindow)) this.captureWindow = 0;
        // 可见标准控件保持原生窗口命中；落在 DirectDraw 容器上的 RA2 输入统一
        // 到当前 shell 页坐标系，避免嵌套对话框让 Gadget 把 lParam 解释错位。
        let nativeTarget = latchedTarget || this.hitTestWindow(screenX, screenY, this.primaryWindow, true);
        // RA2 的自绘下拉把原生 ComboBox 隐藏起来，只让 Gadget 画出选择框。
        // 文字区不能再交给 Gadget（它会误把整块矩形当成展开按钮）；右侧
        // 三角区仍保留 shell 页目标，由客体的自绘下拉逻辑负责展开。
        if (
          !latchedTarget &&
          (message === 0x0201 || message === 0x0202) &&
          this.gameProfile.shell?.initializeComboDropWindow &&
          this.windowClassNames.get(nativeTarget)?.toLowerCase() === '#32770'
        ) {
          nativeTarget = this.hitTestDrawnComboText(screenX, screenY, nativeTarget) || nativeTarget;
        }
        hostHitHwnd = nativeTarget;
        // Westwood 的弹层与滚动条是同一父窗口下相邻的两个 HWND。
        // 弹层持续捕获鼠标；滚动条区域仍须交给原生控件，否则按箭头会选中末行。
        const dropScrollbar =
          this.windowClassNames.get(this.captureWindow)?.toLowerCase() === 'combodropwin' &&
          this.windowClassNames.get(nativeTarget)?.toLowerCase() === 'scrollbar' &&
          this.scrollbarOwner(nativeTarget) === this.captureWindow
            ? nativeTarget
            : 0;
        // ComboBox 会在展开时保留自身的 capture，但真实 ComboDropWin 是浮在
        // 同级控件之上的弹层；点击弹层时必须优先把消息交给弹层，不能让下方
        // 的虚拟 ComboBox 再次处理一次展开/收起。
        const dropWindow = this.windowClassNames.get(nativeTarget)?.toLowerCase() === 'combodropwin' ? nativeTarget : 0;
        // Campaign 的 owner-draw Static 与真实 Win32 一样保持 HTTRANSPARENT。
        // 父对话框在 WM_NCHITTEST 分支用 ChildWindowFromPointEx 判断 1770..1772，
        // 并启动徽标动画和 hover 音效；直接改投 Static 会绕开该分支。
        // A #32770 picked by z-order can be a modal dialog owned directly by the primary window rather
        // than a page nested inside the active shell page. Unifying that one to the active page would
        // hand the click to the page underneath and leave the modal without input, so only dialogs inside
        // the active page's tree keep the coordinate unification; every other #32770 keeps its native hit.
        const retargetChrome =
          this.gameProfile.shell?.retargetDialogChrome === true &&
          this.windowClassNames.get(nativeTarget)?.toLowerCase() === '#32770' &&
          (this.activeShellPage === 0 || this.isWindowInTree(nativeTarget, this.activeShellPage));
        const target =
          latchedTarget ||
          this.scrollbarDrag?.hwnd ||
          dropScrollbar ||
          dropWindow ||
          this.captureWindow ||
          (retargetChrome ? this.hitTestShellPage(screenX, screenY, this.primaryWindow) : nativeTarget);
        if (target) {
          if (
            message === 0x0201 &&
            (['combobox', 'combodropwin', 'scrollbar'].includes(
              this.windowClassNames.get(target)?.toLowerCase() ?? '',
            ) ||
              (this.gameProfile.shell?.initializeComboDropWindow === true &&
                this.windowClassNames.get(target)?.toLowerCase() === '#32770'))
          ) {
            // ComboBox/自绘 shell 页的按下处理可能同步显示 ComboDropWin；抬起仍应
            // 投给本次按下命中的窗口，不能因为弹层刚出现就把一次点击拆给两个 HWND。
            this.hostPointerCapture = target;
          }
          hwnd = target;
          const origin = this.screenOrigin(target);
          const clientX = screenX - origin.x;
          const clientY = screenY - origin.y;
          if (shimTraceEnabled('VM_TRACE_GADGET')) {
            console.log(
              `🧭 host mouse screen=(${screenX},${screenY}) native=0x${nativeTarget.toString(16)}:${this.windowClassNames.get(nativeTarget) ?? ''} target=0x${target.toString(16)}:${this.windowClassNames.get(target) ?? ''} client=(${clientX},${clientY})`,
            );
          }
          lParam = (((clientY & 0xffff) << 16) | (clientX & 0xffff)) >>> 0;
          // Synthesize WM_NCHITTEST only when the child changes, matching dialog last-ID deduplication
          // and preserving movement coalescing within one child. NCHITTEST lParam uses screen coordinates.
          // Do not synthesize before input readiness during the MCI inner pump; after cached movement joins the main queue,
          // the first ready movement detects the edge and sends the missing notification.
          if (message === 0x0200 && this.inputReady) {
            const child = this.childWindowFromPoint(target, clientX, clientY, 1); // CWP_SKIPINVISIBLE
            if (child !== this.lastHitTestChild) {
              this.lastHitTestChild = child;
              hitTest = {
                hwnd: target,
                lParam: (((screenY & 0xffff) << 16) | (screenX & 0xffff)) >>> 0,
              };
              // Count Campaign-logo enter edges so browser smoke tests can assert a single hover trigger.
              const menu = this.campaignMenu();
              const childId = this.controlIds.get(child) ?? 0;
              if (menu && childId >= menu.badgeControlIdRange[0] && childId <= menu.badgeControlIdRange[1]) {
                this.campaignHoverDispatchCount++;
              }
            }
          }
        }
      }
      message = this.translatePointerDoubleClick(hwnd, message, lParam);
      const queued: MessageState = {
        hwnd,
        message,
        wParam: wParam >>> 0,
        lParam: lParam >>> 0,
        time: this.clock.now() >>> 0,
        x: this.cursorX,
        y: this.cursorY,
        ...(message >= 0x0200 && message <= 0x020e
          ? {
              modifierKeyState:
                (this.keyStates.get(0xa0) ? 0x01 : 0) |
                (this.keyStates.get(0xa1) ? 0x02 : 0) |
                (this.keyStates.get(0xa2) ? 0x04 : 0) |
                (this.keyStates.get(0xa3) ? 0x08 : 0),
            }
          : {}),
      };
      if (message >= 0x0200 && message <= 0x020e) {
        this.hostInputTrace.push({
          phase: 'post',
          hwnd,
          hitHwnd: hostHitHwnd || hwnd,
          pointerX: inputX,
          pointerY: inputY,
          message,
          callback: this.windows.get(hwnd) ?? 0,
          className: this.windowClassNames.get(hwnd)?.toLowerCase() ?? '',
          lParam,
        });
        if (this.hostInputTrace.length > 24) this.hostInputTrace.splice(0, this.hostInputTrace.length - 24);
      }
      // WM_NCHITTEST is synchronous send, not post: deliver it to the hit window at the next API boundary before this movement,
      // letting the dialog record the hovered child before handling WM_MOUSEMOVE.
      const enqueueInput = (queue: MessageState[]) => {
        if (hitTest) {
          this.enqueueMessage(this.pendingHostDispatches, {
            hwnd: hitTest.hwnd,
            message: 0x0084, // WM_NCHITTEST
            wParam: 0,
            lParam: hitTest.lParam,
            time: this.clock.now() >>> 0,
            x: this.cursorX,
            y: this.cursorY,
          });
        }
        this.enqueueMessage(queue, queued);
      };
      // After PeekMessageA retrieves MSG, RA2 first runs Westwood Gadget preprocessing and dispatches only
      // unconsumed messages. Directly calling the hit HWND's WndProc bypasses country dropdowns,
      // player names, and other Gadgets; RA2 must retain the actual message-queue path.
      if (this.inputReady && this.gameProfile.shell?.mouseViaMessageQueue && message >= 0x0200 && message <= 0x020e) {
        enqueueInput(this.messages);
        return;
      }
      // Other existing games' shell inner pumps Peek without Dispatch; keep synchronously invoking
      // the hit control procedure at the next API boundary.
      if (this.inputReady && message >= 0x0200 && message <= 0x020e) {
        enqueueInput(this.pendingHostDispatches);
        return;
      }
      // MCI initialization also has an inner pump. Cache host input until the native main pump is ready,
      // or mouse movement during loading could make MCI call the main WndProc prematurely.
      enqueueInput(this.inputReady ? this.messages : this.pendingHostMessages);
    }

    /**
     * USER32 generates double-clicks from the target class's CS_DBLCLKS; browsers report only two physical downs.
     * DirectDraw/Gadget windows without that style must still receive the second WM_*BUTTONDOWN.
     */
    protected translatePointerDoubleClick(hwnd: number, message: number, lParam: number): number {
      if (message !== 0x0201 && message !== 0x0204 && message !== 0x0207) return message;
      const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
      if (((this.windowClassStyles.get(className) ?? 0) & 0x0008) === 0) return message;
      const now = this.clock.now();
      const x = (lParam << 16) >> 16;
      const y = lParam >> 16;
      const previous = this.lastPointerDown;
      const isDouble =
        previous?.hwnd === hwnd &&
        previous.message === message &&
        now - previous.time <= 500 &&
        Math.abs(previous.x - x) <= 4 &&
        Math.abs(previous.y - y) <= 4;
      this.lastPointerDown = isDouble ? null : { hwnd, message, time: now, x, y };
      return isDouble ? message + 2 : message;
    }

    /** Topmost visible shell page containing the coordinates; guest Gadgets hit-test leaf controls themselves. */
    protected hitTestShellPage(x: number, y: number, root: number): number {
      let page = 0;
      for (const hwnd of this.windowZOrder) {
        if (
          this.windowClassNames.get(hwnd)?.toLowerCase() !== '#32770' ||
          this.windowParents.get(hwnd) !== root ||
          !this.isWindowVisible(hwnd) ||
          (this.activeShellPage !== 0 && hwnd !== this.activeShellPage)
        )
          continue;
        const rect = this.screenRect(hwnd);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          x >= rect.x &&
          y >= rect.y &&
          x < rect.x + rect.width &&
          y < rect.y + rect.height
        )
          page = hwnd;
      }
      return page || root;
    }

    /** 找到 RA2 隐藏的 owner-draw ComboBox 文字区；三角区返回 0，继续走 Gadget。 */
    protected hitTestDrawnComboText(x: number, y: number, dialog: number): number {
      if (!this.gameProfile.shell?.initializeComboDropWindow || !dialog) return 0;
      let best = 0;
      for (const hwnd of this.windowZOrder) {
        if (this.windowClassNames.get(hwnd)?.toLowerCase() !== 'combobox') continue;
        if (this.isWindowVisible(hwnd) || !this.isWindowTreeEnabled(hwnd)) continue;
        const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
        if ((style & 0x3) !== 0x3 || !this.isWindowInTree(hwnd, dialog)) continue;
        const rect = this.screenRect(hwnd);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          x < rect.x ||
          y < rect.y ||
          x >= rect.x + rect.width ||
          y >= rect.y + rect.height
        )
          continue;
        const point = ((((y - rect.y) & 0xffff) << 16) | ((x - rect.x) & 0xffff)) >>> 0;
        if (!this.isComboDropButtonHit(hwnd, point)) best = hwnd;
      }
      return best;
    }

    /** Win32 ChildWindowFromPoint[Ex] 只检查 parent 的直接子窗口，不递归。
     * 非 Ex 版本不会自动忽略隐藏或禁用子窗口；Ex 版本由 CWP_* flags 决定。 */
    protected childWindowFromPoint(parent: number, x: number, y: number, flags: number): number {
      if (!parent || !this.windows.has(parent)) return 0;
      const children = this.windowZOrder.filter((hwnd) => this.windowParents.get(hwnd) === parent).reverse();
      for (const hwnd of children) {
        const style = this.windowLongs.get(`${hwnd}:-16`) ?? 0;
        const exStyle = this.windowLongs.get(`${hwnd}:-20`) ?? 0;
        if ((flags & 0x0001) !== 0 && (style & 0x10000000) === 0) continue; // CWP_SKIPINVISIBLE
        if ((flags & 0x0002) !== 0 && (style & 0x08000000) !== 0) continue; // CWP_SKIPDISABLED
        if ((flags & 0x0004) !== 0 && (exStyle & 0x00000020) !== 0) continue; // CWP_SKIPTRANSPARENT
        const rect = this.windowRects.get(hwnd);
        if (!rect || x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) continue;
        return hwnd;
      }
      return parent;
    }

    /**
     * Native window managers hit-test children before queueing. Buttons/edits consume mouse input; Static backgrounds use HTTRANSPARENT so they cannot cover the whole menu.
     */
    protected hitTestWindow(x: number, y: number, root: number, interactiveOnly: boolean): number {
      let best = root;
      let bestRank = -1;
      for (const hwnd of this.windowZOrder) {
        if (hwnd === root) continue;
        const className = this.windowClassNames.get(hwnd)?.toLowerCase() ?? '';
        if (!this.isWindowVisible(hwnd) || !this.isActiveShellWindow(hwnd)) continue;
        const isComboDropWindow =
          this.gameProfile.shell?.initializeComboDropWindow === true && className === 'combodropwin';
        let parent = this.windowParents.get(hwnd) ?? 0;
        let depth = 0;
        let descendant = false;
        let comboDropAncestor = isComboDropWindow ? hwnd : 0;
        // Topmost window on this chain: the direct child of root for an ordinary descendant, or the
        // highest existing window when the chain never reaches root (WS_POPUP combo drop windows).
        // Its z-order separates overlapping dialogs; depth alone cannot, because a control of a lower
        // dialog is deeper than the focused dialog covering it.
        let topAncestor = hwnd;
        const seen = new Set<number>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          depth++;
          if (parent === root) {
            descendant = true;
            break;
          }
          if (
            !comboDropAncestor &&
            this.gameProfile.shell?.initializeComboDropWindow === true &&
            this.windowClassNames.get(parent)?.toLowerCase() === 'combodropwin'
          ) {
            comboDropAncestor = parent;
          }
          topAncestor = parent;
          parent = this.windowParents.get(parent) ?? 0;
        }
        // WS_POPUP 的 ComboDropWin 不一定挂在 primary 的 child tree 上；它的
        // 子控件仍应参加命中测试。普通顶层窗口继续被过滤，避免把桌面级窗口
        // 误投进游戏消息队列。
        if (!descendant && !comboDropAncestor) continue;
        if (interactiveOnly) {
          // Static defaults to HTTRANSPARENT in Win32 hit testing. Campaign parent dialogs
          // use ChildWindowFromPoint on WM_MOUSEMOVE/DOWN/UP to locate Allied/Soviet logos;
          // retargeting early to SS_OWNERDRAW Static would prevent the parent from ever receiving clicks.
          // The #32770 dialog itself must remain the target for blank areas.
          if (
            ![
              '#32770',
              'button',
              'edit',
              'listbox',
              'combobox',
              'combodropwin',
              'scrollbar',
              'msctls_trackbar32',
            ].includes(className)
          )
            continue;
        }
        if (interactiveOnly && !this.isWindowTreeEnabled(hwnd)) continue;
        const rect = this.screenRect(hwnd);
        const combo =
          this.windowClassNames.get(hwnd)?.toLowerCase() === 'combobox' ? this.comboStates.get(hwnd) : undefined;
        // Expanded dropdowns participate in hit testing over their popup area, above sibling controls and rows
        // as on real Win32. Without this, popup-item clicks hit underlying neighboring controls,
        // causing the skirmish bug where selecting row 2 unexpectedly opens row 4.
        if (combo?.dropped) rect.height = Math.max(rect.height, combo.droppedHeight);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          x < rect.x ||
          y < rect.y ||
          x >= rect.x + rect.width ||
          y >= rect.y + rect.height
        )
          continue;
        // Win32 resolves the topmost top-level window under the point first and only then descends, so
        // z-order outranks depth. Depth alone let a control of a lower dialog win over the focused dialog
        // covering it, which is what routed post-save clicks into a ListBox of the page below.
        // A real ComboDropWin keeps its own tier above sibling ComboBox virtual expanded rects, and those
        // expanded rects in turn keep a tier above the ordinary z-order step: the popup area a ComboBox
        // paints over its neighbors is topmost in real Win32, so z-order must not hand the click to a
        // sibling row that merely sits higher in the z list.
        // The tier table stays inside Number's exact-integer range; depth is capped well below the z step.
        const tier = comboDropAncestor ? 2 : combo?.dropped ? 1 : 0;
        const zIndex = Math.max(0, this.windowZOrder.indexOf(topAncestor));
        const rank =
          tier * 1e12 +
          zIndex * 1e6 +
          Math.min(depth, 999) * 1e3 +
          (comboDropAncestor && className === 'combodropwin' ? 3 : 0);
        if (rank >= bestRank) {
          best = hwnd;
          bestRank = rank;
        }
      }
      return best;
    }

    /** Disabling a parent implicitly blocks input to all descendants, even without WS_DISABLED on child HWNDs. */
    protected isWindowTreeEnabled(hwnd: number): boolean {
      const seen = new Set<number>();
      while (hwnd && !seen.has(hwnd)) {
        seen.add(hwnd);
        if (((this.windowLongs.get(`${hwnd}:-16`) ?? 0) & 0x08000000) !== 0) return false;
        hwnd = this.windowParents.get(hwnd) ?? 0;
      }
      return true;
    }

    protected isWindowInTree(hwnd: number, root: number): boolean {
      if (!hwnd || !root) return false;
      const seen = new Set<number>();
      while (hwnd && !seen.has(hwnd)) {
        if (hwnd === root) return true;
        seen.add(hwnd);
        hwnd = this.windowParents.get(hwnd) ?? 0;
      }
      return false;
    }
  };
}
