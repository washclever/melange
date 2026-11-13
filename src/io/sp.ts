/**
 * .sp 내보내기·불러오기 (설계서 E22 · E23 · E28).
 *
 * 내보낸 파일은 ngspice 같은 SPICE 프로그램에서 그대로 돌고, 우리 툴로 다시 열면
 * 회로도까지 돌아온다. 회로도 복원 정보는 SPICE 가 읽지 않는 주석 줄(`*`)에 넣는다.
 *
 * 파일 모양:
 *   * <프로젝트 이름>                     <- 제목 줄. SPICE 는 첫 줄을 무조건 제목으로 읽는다
 *   *@sch-begin v1 body=<본문 SHA-256>
 *   *@ <프로젝트 JSON 을 base64 로, 76자씩>
 *   *@sch-end
 *   V1 in 0 SIN(0 1 1k 0 0 0)            <- 여기부터 .end 까지가 '본문'
 *   ...
 *   .end
 *
 * 본문 해시를 두는 이유: 누가 텍스트 에디터로 넷리스트만 고쳤을 때
 * 회로도와 어긋났다는 것을 알아채기 위해서다.
 */
import { normalizeProject, serialize, type Project } from "../doc/types.ts";
import { asciiTitle, parseEng } from "../doc/units.ts";

const BEGIN = "*@sch-begin";
const END = "*@sch-end";
const CHUNK = 76;

// ── base64 (환경 차이를 타지 않게 직접 구현) ───────────────────────────
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let o = 0, buf = 0, bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── 내보내기 ──────────────────────────────────────────────────────────
/**
 * 내보낼 때 **우리 앱 안에서만 뜻이 있는 경로**를 걷어낸다.
 *
 * SKY130 모델은 워커가 엔진의 가상 파일 시스템에 올려 두는 것이라, 넷리스트의
 * `.include /sky130-nfet.spice` 는 이 앱 밖에서는 가리킬 곳이 없다. 그대로 내보내면
 * 데스크톱 ngspice 에서 "파일 없음" 으로 죽는다 — 내보낸 파일은 그대로 돌아야 한다는
 * 것이 이 기능의 약속이다(설계서 E22).
 *
 * 지우기만 하면 모델이 없어 역시 안 도니까, **무엇을 끼워 넣으면 되는지** 적어 둔다.
 * 우리가 다시 읽을 때는 회로도를 `*@` 복원 정보에서 되살리므로 이 줄은 쓰이지 않는다.
 */
function portableModels(body: string): string {
  const lines = body.split("\n");
  const isOurs = (l: string) => /^\s*\.include\s+\/sky130-[\w-]+\.spice\s*$/i.test(l);
  if (!lines.some(isOurs)) return body;
  const note = [
    "* SKY130 models are supplied by Melange at run time and are not in this file.",
    "* To run this deck elsewhere, point the line below at your own PDK and uncomment it:",
    "** .lib $PDK_ROOT/sky130A/libs.tech/ngspice/sky130.lib.spice tt",
  ];
  const out: string[] = [];
  let done = false;
  for (const l of lines) {
    if (!isOurs(l)) { out.push(l); continue; }
    if (!done) { out.push(...note); done = true; }
  }
  return out.join("\n");
}

/**
 * 프로젝트와 이미 만들어 둔 넷리스트 본문을 합쳐 .sp 텍스트를 만든다.
 * body 는 `buildNetlist` 가 낸 것에서 제목 줄을 뺀 나머지다.
 */
export async function exportSp(project: Project, netlist: string): Promise<string> {
  // buildNetlist 의 첫 줄은 제목 주석이라 본문에서 뺀다
  const body = portableModels(netlist.split("\n").slice(1).join("\n").trim()) + "\n";
  const hash = await sha256(body);

  const json = new TextEncoder().encode(serialize(project));
  const b64 = b64encode(json);
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) chunks.push("*@ " + b64.slice(i, i + CHUNK));

  return [
    `* ${project.name}`,
    `${BEGIN} v1 body=${hash}`,
    ...chunks,
    END,
    body.trimEnd(),
    "",
  ].join("\n");
}

// ── 불러오기 ──────────────────────────────────────────────────────────
export type SpLoad =
  /** 우리가 내보낸 파일이고 본문이 그대로다 — 회로도를 복원한다 */
  | { kind: "restored"; project: Project; body: string }
  /** 복원 정보는 있는데 본문이 바뀌었다 — 사용자가 고른다 */
  | { kind: "drifted"; project: Project; body: string; storedHash: string; actualHash: string }
  /** 복원 정보가 없는 외부 .sp — 넷리스트로 바로 돌린다 (E28) */
  | { kind: "external"; body: string; title: string };

/**
 * `.end` 뒤는 읽지 않는다 (설계서 '외부 .sp 읽기 규칙').
 *
 * 그냥 넘기면 ngspice 가 `.end` 뒤의 줄까지 파싱하려다
 * "unknown device type" 으로 실패한다. 매뉴얼상 거기서 끝이어야 하지만
 * 이 빌드는 멈추지 않으므로 우리가 잘라서 넘긴다.
 */
function truncateAtEnd(lines: string[]): string[] {
  const i = lines.findIndex(l => /^\s*\.end\s*$/i.test(l));
  return i < 0 ? lines : lines.slice(0, i + 1);
}

export async function parseSp(text: string): Promise<SpLoad> {
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex(l => l.trimStart().startsWith(BEGIN));
  const end = lines.findIndex(l => l.trimStart().startsWith(END));

  // 본문: 복원 정보가 있으면 sch-end 다음부터, 없으면 제목 줄 다음부터
  const bodyFrom = begin >= 0 && end > begin ? end + 1 : 1;
  const body = truncateAtEnd(lines.slice(bodyFrom)).join("\n").trim() + "\n";

  if (begin < 0 || end <= begin) {
    const title = (lines[0] ?? "").replace(/^\*\s?/, "").trim() || "External netlist";
    return { kind: "external", body, title };
  }

  const storedHash = /body=([0-9a-f]+)/i.exec(lines[begin])?.[1] ?? "";
  const b64 = lines.slice(begin + 1, end)
    .map(l => l.replace(/^\s*\*@\s?/, ""))
    .join("");

  let project: Project;
  try {
    project = normalizeProject(JSON.parse(new TextDecoder().decode(b64decode(b64))));
  } catch {
    const title = (lines[0] ?? "").replace(/^\*\s?/, "").trim() || "External netlist";
    return { kind: "external", body, title };
  }

  const actualHash = await sha256(body);
  return actualHash === storedHash
    ? { kind: "restored", project, body }
    : { kind: "drifted", project, body, storedHash, actualHash };
}

/**
 * 본문 앞에 제목 줄을 붙여 실제로 돌릴 수 있는 넷리스트로 만든다.
 *
 * SPICE 는 넷리스트의 첫 줄을 무조건 제목으로 읽고 버린다. 그래서 본문만 넘기면
 * 첫 소자 줄이 제목으로 먹혀 조용히 사라진다 — 회로가 끊긴 채로 돌아서
 * "singular matrix" 같은 엉뚱한 오류가 난다. 틀린 답이 아니라 아예 다른 회로다.
 */
export const runnable = (title: string, body: string): string =>
  `* ${asciiTitle(title)}\n${body.replace(/^\s*\n/, "")}`;

/**
 * 넷리스트 텍스트에서 첫 사인원의 주파수를 읽는다.
 * `SIN(오프셋 진폭 주파수 ...)` 의 셋째 자리다.
 * 외부 .sp 에는 회로도가 없어서 파형 진폭을 재려면 여기서 주파수를 얻어야 한다.
 */
export function sineFreq(netlist: string): number | null {
  const m = /\bSIN\s*\(\s*\S+\s+\S+\s+([^\s)]+)/i.exec(netlist);
  return m ? parseEng(m[1]) : null;
}

// ── 외부 .sp 훑어보기 ─────────────────────────────────────────────────
export interface SpScan {
  /** 이어 붙이고 주석을 뺀 실제 줄들 */
  lines: string[];
  /** `.tran` 등 해석 줄 */
  analyses: string[];
  /** 1차에서 못 다루는 것들 */
  unsupported: string[];
}

/**
 * 외부 .sp 를 훑는다. `+` 로 시작하는 줄은 앞 줄에 이어 붙이고,
 * `*` 로 시작하는 줄은 주석이며, `.end` 뒤는 읽지 않는다 (설계서 '외부 .sp 읽기 규칙').
 */
export function scanSp(text: string): SpScan {
  const out: string[] = [];
  const analyses: string[] = [];
  const unsupported: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*")) continue;
    if (/^\.end\b/i.test(line)) break;
    if (line.startsWith("+") && out.length) { out[out.length - 1] += " " + line.slice(1).trim(); continue; }
    out.push(line);
  }

  for (const l of out) {
    // 우리가 돌릴 수 있는 해석. .op·.dc·.ac 는 '해석 네 가지' 에서, .noise·.tf 는 계산기와 함께 들어왔다
    if (/^\.(tran|op|dc|ac|noise|tf)\b/i.test(l)) analyses.push(l);
    else if (/^\.(meas|disto|pz|sens|four)\b/i.test(l)) unsupported.push(l);
    else if (/^\.control\b/i.test(l)) unsupported.push(l);
    else if (/^\.(include|lib)\b/i.test(l)) unsupported.push(l);
  }

  return { lines: out, analyses, unsupported };
}
