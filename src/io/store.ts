/**
 * 브라우저 안 저장소 (설계서 E19).
 *
 * 프로젝트 원본은 IndexedDB 에 둔다. 편집하고 2초 뒤 자동 저장하고, Ctrl+S 는 바로 저장한다.
 * localStorage 가 아니라 IndexedDB 인 이유는 프로젝트가 수 MB 까지 커질 수 있어서다
 * (프로젝트 라이브러리에 쓴 부품 정의 사본이 들어간다).
 *
 * 저장이 실패해도 편집은 계속돼야 한다. 사생활 보호 모드나 저장 공간 부족에서
 * IndexedDB 는 그냥 던지는데, 그 때문에 그리던 회로가 날아가면 안 된다.
 */
import { normalizeProject, type Project } from "../doc/types.ts";

const DB = "melange";
const STORE = "projects";
const KEY = "current";
const SAVE_DELAY_MS = 2000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(value: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function get(): Promise<string | null> {
  const db = await open();
  const v = await new Promise<string | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return v;
}

export type SaveState = "Saved" | "Saving…" | "Not saved";

/**
 * 자동 저장기. 문서가 바뀔 때마다 `touch()` 를 부르면 2초 뒤에 한 번 저장한다.
 * 연달아 불러도 타이머가 밀릴 뿐이라 저장이 폭주하지 않는다.
 */
export class AutoSave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = "";
  private onState: (s: SaveState, detail?: string) => void;

  constructor(onState: (s: SaveState, detail?: string) => void) {
    this.onState = onState;
  }

  touch(project: Project): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(project), SAVE_DELAY_MS);
  }

  /** Ctrl+S 나 탭을 떠날 때 즉시 저장 */
  async flush(project: Project): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    /*
     * 그냥 JSON.stringify 다. 내보내기용 serialize() 는 키를 정렬하고 들여 써서 "같은 문서는
     * 같은 바이트" 를 지키는데, 그 정렬이 비싸다 — 부품 1만 개에서 100 ms, 5만 개에서 0.5초가
     * 편집할 때마다 2초 뒤 메인 스레드를 멈췄다. 자동 저장은 다시 읽기만 하면 되니 키 순서가
     * 상관없다 (그냥 stringify 는 15 ms · 70 ms).
     */
    const text = JSON.stringify(project);
    if (text === this.last) { this.onState("Saved"); return; }
    this.onState("Saving…");
    try {
      await put(text);
      this.last = text;
      this.onState("Saved");
    } catch (e) {
      // 저장이 안 되더라도 편집은 계속된다. 상태만 알린다
      this.onState("Not saved", e instanceof Error ? e.message : String(e));
    }
  }

  /** 마지막으로 저장된 프로젝트. 없거나 읽기 실패면 null */
  static async load(): Promise<Project | null> {
    try {
      const text = await get();
      if (!text) return null;
      const p = JSON.parse(text) as Project;
      // 예전 판에서 저장한 것이면 해석 설정에 kind 가 없다
      return p.formatVersion === 1 && p.sheets?.length ? normalizeProject(p) : null;
    } catch {
      return null;
    }
  }

  /** 저장된 것을 지운다 (새로 시작) */
  static async clear(): Promise<void> {
    try {
      const db = await open();
      await new Promise<void>(resolve => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      db.close();
    } catch { /* 지우지 못해도 그만이다 */ }
  }
}
