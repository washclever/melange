/**
 * 어시스턴트의 작은 저장소 — 프로젝트마다 대화를 둔다 (다시 열면 이어진다).
 *
 * 앱의 자동 저장(src/io/store.ts)과 **다른 데이터베이스**다 ("melange-ai"). 같은 데이터베이스에 저장소를
 * 하나 더 만들려면 버전을 올려야 하는데, 그러면 store.ts 의 `indexedDB.open("melange", 1)` 이 그 뒤로
 * VersionError 로 실패한다 — 어시스턴트 때문에 회로의 자동 저장이 멈춘다. 따로 두면 그럴 일이 없다.
 *
 * 쓸 때마다 메모리에도 적는다. IndexedDB 를 못 쓰는 곳(사생활 보호 창, node 검증)에서도 이 탭이
 * 살아 있는 동안은 돈다.
 */
const DB = "melange-ai";
const STORE = "kv";

const memory = new Map<string, unknown>();
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no IndexedDB"));
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error); };
  });
  return opening;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const v = await tx("readonly", s => s.get(key));
    if (v !== undefined) return v as T;
  } catch { /* 메모리에서 */ }
  return memory.get(key) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  memory.set(key, value);
  try { await tx("readwrite", s => s.put(value, key)); } catch { /* 메모리에는 있다 */ }
}

export async function kvDelete(key: string): Promise<void> {
  memory.delete(key);
  try { await tx("readwrite", s => s.delete(key)); } catch { /* 없으면 그만 */ }
}
