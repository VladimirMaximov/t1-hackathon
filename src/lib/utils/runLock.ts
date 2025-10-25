let current: { id: number; release: () => void } | null = null;
let seq = 0;

export function acquireRunLock(release: () => void): number {
    const id = ++seq;
    if (current) {
        try { current.release(); } catch { }
    }
    current = { id, release };
    return id;
}

export function isRunLockActive(id: number | null | undefined): boolean {
    return !!id && current?.id === id;
}

export function clearRunLock(id: number | null | undefined) {
    if (id && current?.id === id) current = null;
}
