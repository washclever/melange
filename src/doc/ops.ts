/**
 * 편집 명령을 만드는 순수 함수들 — 화면(app.ts)과 어시스턴트(src/ai/)가 같이 쓴다.
 *
 * 같은 편집을 두 곳에서 따로 만들면 언젠가 어긋난다. 사람이 돌리면 배선이 따라오는데 어시스턴트가
 * 돌리면 안 따라오는 식으로. 여기 함수들은 문서를 바꾸지 않고 **명령만** 만든다 — 적용은 부르는
 * 쪽이 기록(History)을 거쳐 한다. 알림 창 같은 화면 일도 하지 않는다.
 */
import { Follow } from "./follow.ts";
import {
  batch, findById, setWirePts, transform, xformPoint,
  type Command, type Ref, type Xform,
} from "./history.ts";
import type { SheetIndex } from "./sheet-index.ts";
import { snapPt, uid, type Id, type LibPart, type Part, type Pt, type Sheet } from "./types.ts";
import { defaultParams, ensureInLibrary } from "../lib/parts.ts";

/** 그 접두어의 다음 지정자. R1 · R2 가 있으면 R3. 대소문자는 가리지 않는다 (넷리스트도 안 가린다) */
export function nextRef(sheet: Sheet, prefix: string): string {
  let n = 0;
  const re = new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)$", "i");
  for (const p of sheet.parts) {
    const m = re.exec(p.ref);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return prefix + (n + 1);
}

/**
 * 놓을 부품을 만든다. 문서에 넣는 것은 addPart 명령이 한다.
 * 라이브러리 사본은 여기서 프로젝트 라이브러리에 들어간다 (쓴 부품의 정의만 파일에 실린다).
 */
export function makePart(
  library: Record<string, LibPart>, sheet: Sheet, libId: string, at: Pt,
  rot: Part["rot"] = 0, mirror = false, params?: Record<string, string>, ref?: string,
): Part {
  const lib = ensureInLibrary(library, libId);
  return {
    id: uid(), lib: libId, ref: ref ?? nextRef(sheet, lib.refPrefix), at: snapPt(at),
    rot, mirror, params: { ...defaultParams(lib), ...params },
    // 기본 글자 자리가 심볼과 겹치는 부품은 제 자리를 들고 온다 (LibPart.textAt). 없으면 키도 두지 않는다
    ...(lib.textAt ? { textAt: structuredClone(lib.textAt) } : {}),
  };
}

/**
 * 부품들을 새 자리로. 붙은 배선이 끌기와 같은 길로 따라온다 (doc/follow.ts).
 * 부품마다 움직인 거리가 달라도 된다 — 정렬 · 분배 · 어시스턴트의 옮기기가 이것이다.
 * 움직일 것이 없으면 null.
 */
export function moveCommand(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex,
  moves: ReadonlyArray<{ part: Part; to: Pt }>, label: string,
): Command | null {
  const real = moves.filter(m => m.to[0] !== m.part.at[0] || m.to[1] !== m.part.at[1]);
  if (!real.length) return null;
  const cmds: Command[] = real.map(m =>
    transform([{ kind: "part", id: m.part.id }], { move: [m.to[0] - m.part.at[0], m.to[1] - m.part.at[1]] }, label));
  const to = new Map(real.map(m => [m.part.id, m.to]));
  const follow = new Follow({ sheet, library, parts: real.map(m => m.part), index });
  const shapes = follow.shapes(p => ({ at: to.get(p.id) ?? p.at, rot: p.rot, mirror: p.mirror }));
  cmds.push(...shapes.map(f => setWirePts(f.id, f.pts)));
  return batch(label, cmds);
}

/**
 * 고른 것들을 돌리거나 뒤집는다 (옮기기도 된다). 붙은 배선도 따라온다 — 예전에는 회전 · 대칭이
 * 부품만 돌려서 핀이 배선에서 떨어졌다. 그림으로는 붙어 보여도 넷리스트에서는 끊긴 채였다.
 *
 * movingWires 는 같이 고른 배선 (통째로 같이 움직이므로 늘이지 않는다).
 */
export function xformCommand(
  sheet: Sheet, library: Record<string, LibPart>, index: SheetIndex,
  refs: Ref[], xf: Xform, label: string, movingWires?: ReadonlySet<Id>,
): Command {
  const cmd = transform(refs, xf, label);
  const parts = refs.filter(r => r.kind === "part").map(r => findById(sheet.parts, r.id)).filter((p): p is Part => !!p);
  const follow = new Follow({ sheet, library, parts, movingWires, index });
  if (!follow.attach.length) return cmd;
  /*
   * 새 자세는 명령을 한 번 적용해 읽고 되돌려 얻는다 (회전 중심을 따로 계산하지 않는다).
   * 적용과 되돌리기 사이에 아무것도 그리지 않으므로 문서는 그대로다.
   */
  const rigid = xformPoint(sheet, refs, xf);
  cmd.apply(sheet);
  const poses = new Map(parts.map(p => [p.id, { at: [p.at[0], p.at[1]] as Pt, rot: p.rot, mirror: p.mirror }]));
  cmd.revert(sheet);
  const shapes = follow.shapes(p => poses.get(p.id) ?? p, rigid);
  return batch(label, [cmd, ...shapes.map(f => setWirePts(f.id, f.pts))]);
}
