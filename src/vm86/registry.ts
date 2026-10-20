/** Session-local registry contents with process-local handles. No installation or credential defaults. */
export class RegistryError extends Error {
  constructor(readonly code: number) {
    super(`Registry operation failed (${code})`);
  }
}
const ALL_ACCESS = 0x000f003f;
const ROOTS = [0x80000000, 0x80000001, 0x80000002, 0x80000003, 0x80000005];
class RegistryKey {
  readonly children = new Map<string, RegistryKey>();
  readonly values = new Map<string, { name: string; type: number; bytes: Uint8Array }>();
  deleted = false;
  references = 0;
  modified = Date.now();
  constructor(
    readonly name: string,
    readonly className = '',
    readonly parent?: RegistryKey,
  ) {}
}
export class GuestRegistry {
  readonly roots = new Map(ROOTS.map((root) => [root, new RegistryKey('')]));
}

function components(path: string): string[] {
  const parts = path.replace(/\\+$/, '').split('\\').filter(Boolean);
  if (parts.length > 32 || parts.some((part) => part.length > 255 || part.includes('/'))) throw new RegistryError(87);
  return parts;
}
function accessMask(access: number): number {
  access >>>= 0;
  // The VM exposes one 32-bit view and an unrestricted default ACL. Alternate views,
  // notification, link creation and custom security descriptors are not implemented.
  if (access === 0x02000000) return ALL_ACCESS;
  if ((access & ~ALL_ACCESS) !== 0) throw new RegistryError(50);
  return access;
}

export class RegistryHandles {
  private readonly handles = new Map<number, { key: RegistryKey; access: number }>();
  private nextHandle = 0x6000;
  constructor(private readonly registry: GuestRegistry) {}

  private key(handle: number, access = 0): RegistryKey {
    const root = this.registry.roots.get(handle >>> 0);
    const entry = this.handles.get(handle >>> 0);
    if (!root && !entry) throw new RegistryError(6);
    const key = root ?? entry!.key;
    if (key.deleted) throw new RegistryError(1018);
    if (!root && (entry!.access & access) !== access) throw new RegistryError(5);
    return key;
  }
  private publish(key: RegistryKey, access: number): number {
    const handle = this.nextHandle++;
    this.handles.set(handle, { key, access });
    key.references++;
    return handle;
  }
  open(parent: number, path: string, access: number): number {
    const mask = accessMask(access);
    let key = this.key(parent);
    const parts = components(path);
    for (const part of parts) {
      const child = key.children.get(part.toLowerCase());
      if (!child) throw new RegistryError(2);
      if (child.deleted) throw new RegistryError(1018);
      key = child;
    }
    if (!parts.length && this.registry.roots.has(parent >>> 0)) return parent >>> 0;
    return this.publish(key, mask);
  }
  create(parent: number, path: string, access: number, className: string): { handle: number; disposition: number } {
    const mask = accessMask(access);
    let key = this.key(parent);
    let disposition = 2;
    // Creation is permitted by the virtual hive's default ACL, independently of
    // the parent's handle mask, as with RegCreateKeyEx. Value operations use handle rights.
    const parts = components(path);
    for (const [index, part] of parts.entries()) {
      let child = key.children.get(part.toLowerCase());
      if (child?.deleted) throw new RegistryError(1018);
      disposition = child ? 2 : 1;
      if (!child) {
        child = new RegistryKey(part, index === parts.length - 1 ? className : '', key);
        key.children.set(part.toLowerCase(), child);
        key.modified = Date.now();
      }
      key = child;
    }
    return { handle: this.publish(key, mask), disposition };
  }
  query(handle: number, name: string) {
    const value = this.key(handle, 1).values.get(name.toLowerCase());
    if (!value) throw new RegistryError(2);
    return { type: value.type, bytes: value.bytes.slice() };
  }
  set(handle: number, name: string, type: number, bytes: Uint8Array): void {
    const key = this.key(handle, 2);
    if (name.length > 16383 || bytes.length > 16 * 1024 * 1024) throw new RegistryError(87);
    key.values.set(name.toLowerCase(), { name, type: type >>> 0, bytes: bytes.slice() });
    key.modified = Date.now();
  }
  deleteValue(handle: number, name: string): void {
    const key = this.key(handle, 2);
    if (!key.values.delete(name.toLowerCase())) throw new RegistryError(2);
    key.modified = Date.now();
  }
  deleteKey(handle: number, path: string): void {
    let parent = this.key(handle);
    const parts = components(path);
    if (!parts.length) throw new RegistryError(5);
    for (const part of parts.slice(0, -1)) {
      const child = parent.children.get(part.toLowerCase());
      if (!child) throw new RegistryError(2);
      parent = child;
    }
    const name = parts.at(-1)!.toLowerCase();
    const key = parent.children.get(name);
    if (!key) throw new RegistryError(2);
    if (key.deleted) throw new RegistryError(1018);
    if (key.children.size) throw new RegistryError(5);
    key.deleted = true;
    if (!key.references) parent.children.delete(name);
    parent.modified = Date.now();
    // Existing handles retain the deleted object and fail with ERROR_KEY_DELETED.
    // The name stays reserved until every process closes its handles.
  }
  enumerate(handle: number, index: number) {
    const key = [...this.key(handle, 8).children.values()].filter((child) => !child.deleted)[index >>> 0];
    if (!key) throw new RegistryError(259);
    return { name: key.name, className: key.className, modified: key.modified };
  }
  info(handle: number, length: (text: string) => number = (text) => text.length) {
    const key = this.key(handle, 1);
    const children = [...key.children.values()].filter((child) => !child.deleted);
    const values = [...key.values.values()];
    return {
      className: key.className,
      modified: key.modified,
      subkeys: children.length,
      values: values.length,
      maxSubkey: children.reduce((max, child) => Math.max(max, length(child.name)), 0),
      maxClass: children.reduce((max, child) => Math.max(max, length(child.className)), 0),
      maxValueName: values.reduce((max, value) => Math.max(max, length(value.name)), 0),
      maxValueBytes: values.reduce((max, value) => Math.max(max, value.bytes.length), 0),
    };
  }
  close(handle: number): void {
    if (this.registry.roots.has(handle >>> 0)) return;
    const entry = this.handles.get(handle >>> 0);
    if (!entry) throw new RegistryError(6);
    this.handles.delete(handle >>> 0);
    entry.key.references--;
    if (entry.key.deleted && !entry.key.references) entry.key.parent?.children.delete(entry.key.name.toLowerCase());
  }
  dispose(): void {
    for (const handle of this.handles.keys()) this.close(handle);
  }
}
