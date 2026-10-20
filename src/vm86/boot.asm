; RA2 VM minimal firmware (custom v86 BIOS, 64 KB, reset vector at the end)
; Flow: reset (0xFFFF0) -> real-mode initialization -> protected mode (no paging, ring 0) -> IDT -> host-parsed PE entry
; Memory layout contract (see vm.ts):
;   0x00060000-0x00060FFF  = hypercall/exception shared page
;   0x00070000-0x00070FFF  = minimal TEB (FS segment base)
;   0x00080000-0x000BFFFF  = static Win32 import stubs
;   0x000C0000-0x000EFFFF  = dynamic DLL/COM/thread-exit stubs (first region)
;   0x000F0000-0x000FFFFF  = firmware, GDT, IDT; no dynamic allocation
;   0x00100000-0x001FFFFF  = dynamic stubs (second region)
;   0x00220000-0x0025FFFF  = 64 independent callback slots, 4 KB each
;   0x00073C00-0x00073CFF  = callback-slot owner table (0 = free, otherwise thread ID + 1)
;   0x00071000-0x00072FFF  = fast _lread handle table (only when enabled)
;   0x00400000+            = RA2/YR PE image
;   0x00260000-0x00260FFF  = private common thread contexts (64 x 64 bytes)
;   0x00270000-0x00273FFF  = private IRQ/yield task stacks
;   The host specifies the game stack top at 0x60058 (default 0x700000; movable for large PEs).
;   Stack top+            = shim heap (VirtualAlloc regions allocated independently)
BITS 16
ORG 0xF0000

start16:
    cli
    ; BIOS resides at physical address 0xF0000. Real mode reads the firmware GDTR with DS=0xF000.
    mov ax, 0xF000
    mov ds, ax
    xor ax, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    ; Remap 8259 IRQs to IDT 0x20/0x28 so IRQ0..7 do not overlap CPU exception vectors.
    mov al, 0x11
    out 0x20, al
    out 0xA0, al
    mov al, 0x20
    out 0x21, al
    mov al, 0x28
    out 0xA1, al
    mov al, 0x04
    out 0x21, al
    mov al, 0x02
    out 0xA1, al
    mov al, 0x01
    out 0x21, al
    out 0xA1, al
    mov al, 0xFF
    out 0x21, al
    out 0xA1, al
    ; Load GDT -> protected mode
    lgdt [gdtr - $$]
    mov eax, cr0
    and eax, ~0xC              ; Clear EM/TS for x87 and SSE.
    or eax, 3                 ; Protected mode and monitor coprocessor.
    mov cr0, eax
    ; The flat code segment has base 0, so the offset must be the full physical address 0xFxxxx.
    jmp dword 0x08:start32

BITS 32
start32:
    mov eax, cr4
    or eax, 0x600             ; OSFXSR and OSXMMEXCPT.
    mov cr4, eax
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov gs, ax
    mov ax, 0x18
    mov fs, ax
    lidt [idtr]
    mov ax, 0x20
    ltr ax                       ; IRQ task gates preserve the interrupted program stack.
    ; Hypercall stubs wake from HLT through COM1 RX (IRQ4); IRQ0 provides 100 Hz Win32
    ; guest-thread preemption. All other IRQs remain masked.
    mov dx, 0x3F9
    mov al, 1
    out dx, al
    mov al, 0x34
    out 0x43, al
    mov ax, 11932                 ; 1.193182MHz / 11932 ≈ 100Hz
    out 0x40, al
    mov al, ah
    out 0x40, al
    mov al, 0xEE                  ; master PIC: unmask IRQ0 + IRQ4
    out 0x21, al
    ; The game stack defaults to 1 MB and grows downward. RA2's image reaches 0xB46000,
    ; so the host moves the stack top to 0xD00000; ordinary games still use 0x700000.
    mov esp, [0x60058]
    ; Minimal TEB: SEH chain terminator / stack top / TEB self pointer.
    mov dword [fs:0], -1
    mov [fs:4], esp
    mov dword [fs:0x18], 0x70000
    cli
    cld
    ; Jump to the entry parsed by the host from the PE optional header (such as WinMainCRTStartup).
    mov eax, [0x60044]
    call eax
hang:
    ; Halt after entry returns; publish a marker so the host recognizes game exit outside ExitProcess.
    mov dword [0x6004c], 1
    hlt
    jmp hang

; -- GDT: 0 = null, 1 = code (0x08), 2 = data (0x10); both 4 GB flat ring 0 --
%macro TSS_DESCRIPTOR 1
    dw 103
    dw ((%1 - $$) + 0xF0000) & 0xFFFF
    db (((%1 - $$) + 0xF0000) >> 16) & 0xFF
    db 0x89
    db 0
    db (((%1 - $$) + 0xF0000) >> 24) & 0xFF
%endmacro
align 16
gdt:
    dq 0
    dq 0x00CF9A000000FFFF
    dq 0x00CF92000000FFFF
    ; 0x18: TEB，base=0x70000, limit=0x0fff, 32-bit byte-granularity data segment
    dq 0x0040920700000FFF
    TSS_DESCRIPTOR app_tss       ; 0x20
    TSS_DESCRIPTOR timer_tss     ; 0x28
    TSS_DESCRIPTOR uart_tss      ; 0x30
    TSS_DESCRIPTOR yield_tss     ; 0x38
    TSS_DESCRIPTOR selected_tss  ; 0x40
gdt_end:
gdtr: dw gdt_end - gdt - 1
      dd gdt

; -- IDT: CPU faults publish context; #NM clears task-switch TS; IRQs use private TSS tasks --
; Do not iret from exceptions as if they were IRQs: #GP/#PF and others push an extra error code.
; The old handler mistook it for EIP, causing a secondary "CS selector is invalid" fault.
%macro EXCEPTION_NO_ERROR 1
exception_%1:
    push dword 0
    push dword %1
    jmp exception_common
%endmacro

%macro EXCEPTION_WITH_ERROR 1
exception_%1:
    push dword %1
    jmp exception_common
%endmacro

EXCEPTION_NO_ERROR 0
EXCEPTION_NO_ERROR 1
EXCEPTION_NO_ERROR 2
EXCEPTION_NO_ERROR 3
EXCEPTION_NO_ERROR 4
EXCEPTION_NO_ERROR 5
EXCEPTION_NO_ERROR 6
exception_7:
    ; Hardware task switches set CR0.TS. FPU state is owned by our thread scheduler.
    clts
    iretd
EXCEPTION_WITH_ERROR 8
EXCEPTION_NO_ERROR 9
EXCEPTION_WITH_ERROR 10
EXCEPTION_WITH_ERROR 11
EXCEPTION_WITH_ERROR 12
EXCEPTION_WITH_ERROR 13
EXCEPTION_WITH_ERROR 14
EXCEPTION_NO_ERROR 15
EXCEPTION_NO_ERROR 16
EXCEPTION_WITH_ERROR 17
EXCEPTION_NO_ERROR 18
EXCEPTION_NO_ERROR 19
EXCEPTION_NO_ERROR 20
EXCEPTION_WITH_ERROR 21
EXCEPTION_NO_ERROR 22
EXCEPTION_NO_ERROR 23
EXCEPTION_NO_ERROR 24
EXCEPTION_NO_ERROR 25
EXCEPTION_NO_ERROR 26
EXCEPTION_NO_ERROR 27
EXCEPTION_NO_ERROR 28
EXCEPTION_WITH_ERROR 29
EXCEPTION_WITH_ERROR 30
EXCEPTION_NO_ERROR 31

exception_common:
    mov dword [0x60094], 1       ; Keep PIT scheduling blocked until the saved context is restored.
    ; Stack: vector, error, EIP, CS, EFLAGS. Write status last as the publication signal.
    mov [0x60028], eax
    mov [0x6002C], ecx
    mov [0x60030], edx
    mov [0x60034], ebx
    mov [0x60038], ebp
    mov [0x6003C], esi
    mov [0x60040], edi
    mov eax, [esp + 4]
    mov [0x60014], eax
    mov eax, [esp + 8]
    mov [0x60018], eax
    mov eax, [esp + 12]
    mov [0x6001C], eax
    mov eax, [esp + 16]
    mov [0x60020], eax
    lea eax, [esp + 20]
    mov [0x60024], eax
    mov eax, [esp]
    inc eax
    mov [0x60010], eax
    mov dx, 0x3F8                ; Notify the host immediately after publishing the exception.
    mov al, 'E'
    out dx, al
    cli
.halt:
    cmp dword [0x60010], 0
    je .resume
    sti
    hlt
    cli
    jmp .halt
.resume:
    ; The debugger may update this real exception context while the CPU is stopped.
    mov esp, [0x60024]
    push dword [0x60020]
    push dword [0x6001C]
    push dword [0x60018]
    mov eax, [0x60028]
    mov ecx, [0x6002C]
    mov edx, [0x60030]
    mov ebx, [0x60034]
    mov ebp, [0x60038]
    mov esi, [0x6003C]
    mov edi, [0x60040]
    mov dword [0x60094], 0       ; IF is still clear; IRET atomically restores guest interrupt state.
    iretd

; IRQs execute in real x86 TSS tasks on private stacks. In-place interrupt
; frames would corrupt transient native stack data below ESP (e.g. injector hook returns).
irq_common:
    mov dx, 0x3F8
    in al, dx
    mov al, 0x20
    out 0x20, al
    out 0xA0, al
    iretd
    jmp irq_common

irq_timer:
    clts
    add dword [0x6005C], 10
    adc dword [0x60060], 0
    mov al, 0x20
    out 0x20, al
    cmp dword [0x60094], 0
    jne task_return
    cmp dword [0x6008C], 0
    jne task_return
    inc dword [0x73A00]
    jmp choose_thread

yield_thread:
    clts
    cmp dword [0x6008C], 0
    jne task_return
    jmp choose_thread

selected_thread:
    clts
    mov ebx, [0x60068]
    cmp dword [0x73B00 + ebx*4], 0
    jne .selected
    or dword [app_tss + 0x24], 0x200
.selected:
    mov edx, [0x6006C]
    cmp edx, ebx
    je task_return
    jmp switch_thread

choose_thread:
    mov ebx, [0x60068]
    mov ecx, [0x60074]
    cmp ecx, 1
    jbe task_return
    mov edx, ebx
    mov esi, ecx
    dec esi
.next:
    inc edx
    cmp edx, ecx
    jb .candidate
    xor edx, edx
.candidate:
    mov edi, [0x73900 + edx*4]
    cmp edi, 1
    je switch_thread
    cmp edi, 2
    jb .miss
    sub edi, 2
    mov eax, [0x73A00]
    sub eax, edi
    js .miss
    mov dword [0x73900 + edx*4], 1
    jmp switch_thread
.miss:
    dec esi
    jnz .next
    jmp task_return

%macro TSS_TO_CONTEXT 2
    mov eax, [app_tss + %2]
    mov [edi + %1], eax
%endmacro
%macro CONTEXT_TO_TSS 2
    mov eax, [esi + %1]
    mov [app_tss + %2], eax
%endmacro

switch_thread:
    ; Keep the existing pushad/EFLAGS/EIP contract in private, per-thread storage.
    ; Its saved-ESP field points to the logical EFLAGS slot, eight bytes below actual ESP.
    mov edi, ebx
    shl edi, 6
    add edi, 0x260000
    mov [0x73400 + ebx*4], edi
    TSS_TO_CONTEXT 0, 0x44
    TSS_TO_CONTEXT 4, 0x40
    TSS_TO_CONTEXT 8, 0x3C
    mov eax, [app_tss + 0x38]
    sub eax, 8
    mov [edi + 12], eax
    TSS_TO_CONTEXT 16, 0x34
    TSS_TO_CONTEXT 20, 0x30
    TSS_TO_CONTEXT 24, 0x2C
    TSS_TO_CONTEXT 28, 0x28
    TSS_TO_CONTEXT 32, 0x24
    TSS_TO_CONTEXT 36, 0x20
    shl ebx, 9
    fxsave [0x78000 + ebx]
    shr ebx, 9
    mov eax, [0x70000]
    mov [0x73500 + ebx*4], eax
    mov eax, [0x70004]
    mov [0x73600 + ebx*4], eax
    mov eax, [0x70008]
    mov [0x73700 + ebx*4], eax
    mov eax, [0x60064]
    mov [0x73800 + ebx*4], eax

    mov [0x60068], edx
    mov [0x6006C], edx
    mov esi, [0x73400 + edx*4]
    CONTEXT_TO_TSS 0, 0x44
    CONTEXT_TO_TSS 4, 0x40
    CONTEXT_TO_TSS 8, 0x3C
    mov eax, [esi + 12]
    add eax, 8
    mov [app_tss + 0x38], eax
    CONTEXT_TO_TSS 16, 0x34
    CONTEXT_TO_TSS 20, 0x30
    CONTEXT_TO_TSS 24, 0x2C
    CONTEXT_TO_TSS 28, 0x28
    CONTEXT_TO_TSS 32, 0x24
    CONTEXT_TO_TSS 36, 0x20
    shl edx, 9
    fxrstor [0x78000 + edx]
    shr edx, 9
    mov eax, [0x73500 + edx*4]
    mov [0x70000], eax
    mov eax, [0x73600 + edx*4]
    mov [0x70004], eax
    mov eax, [0x73700 + edx*4]
    mov [0x70008], eax
    mov eax, [0x73800 + edx*4]
    mov [0x60064], eax

task_return:
    ; NT returns to the interrupted task; no frame is written into its program stack.
    iretd
    ; TSS EIP is saved after IRET, so each reusable handler restarts on its next entry.
    str ax
    cmp ax, 0x28
    je irq_timer
    cmp ax, 0x38
    je yield_thread
    jmp selected_thread

%macro TSS_IMAGE 2
    times 0x20 db 0
    dd %1
    dd 2
    times 4 dd 0                ; EAX, ECX, EDX, EBX
    dd %2                      ; Private kernel ESP
    times 3 dd 0               ; EBP, ESI, EDI
    dd 0x10, 0x08, 0x10, 0x10, 0x18, 0x10
    dd 0                       ; LDT
    dw 0, 104                  ; Debug trap / I/O bitmap outside the TSS
%endmacro
align 16
app_tss: times 104 db 0
align 16
timer_tss: TSS_IMAGE irq_timer, 0x271000
align 16
uart_tss: TSS_IMAGE irq_common, 0x272000
align 16
yield_tss: TSS_IMAGE yield_thread, 0x273000
align 16
selected_tss: TSS_IMAGE selected_thread, 0x274000

%macro IDT_GATE 1
    dw ((%1 - $$) + 0xF0000) & 0xFFFF
    dw 0x08
    db 0
    db 0x8E
    dw (((%1 - $$) + 0xF0000) >> 16) & 0xFFFF
%endmacro

%macro IDT_TASK_GATE 1
    dw 0, %1
    db 0, 0x85
    dw 0
%endmacro
align 8
idt:
%assign vector 0
%rep 32
    IDT_GATE exception_%+vector
%assign vector vector+1
%endrep
    IDT_TASK_GATE 0x28
%rep 15
    IDT_TASK_GATE 0x30
%endrep
    IDT_TASK_GATE 0x38           ; Round-robin voluntary yield (INT 0x30)
    IDT_TASK_GATE 0x40           ; Host-selected API continuation (INT 0x31)
%rep 206
    IDT_TASK_GATE 0x30
%endrep
idtr: dw 256*8 - 1
      dd idt

; -- Reset vector --
times 0xFFF0 - ($-$$) db 0
    ; Reset defaults to 16-bit mode; explicitly emit a 16:16 far jump so NASM does not choose 16:32 due to ORG.
    db 0xEA
    dw start16 - $$
    dw 0xF000
times 0x10000 - ($-$$) db 0
