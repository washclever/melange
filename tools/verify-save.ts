// 실행할 때 붙이는 .save 규칙 검증 (src/net/netlist.ts savePlan).
//
// 저장을 줄이면 빠르고 가볍지만, 줄이면 안 되는 것을 줄이면 조용히 틀린다: .meas 가 읽는 벡터를
// 빼면 측정이 'failed' 가 되고, 회로도에 없는 노드(지시문 블록의 소자 줄)를 빼면 파형이 사라진다.
// 그래서 줄이는 규칙과 '줄이지 않는' 규칙을 둘 다 못 박는다. 엔진으로 돌려서 값이 같은지는
// tools/e2e.ts 가 본다.
import { MANY_NETS, beforeEnd, savePlan } from "../src/net/netlist.ts";
import type { SpiceBlock } from "../src/doc/types.ts";

let fail = 0;
const ok = (cond: boolean, msg: string, detail = "") => {
  if (!cond) fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "   " + detail : ""}`);
};
const block = (lines: string[], active = true): SpiceBlock => ({ id: "b", at: [0, 0], lines, active });
const saved = (lines: string[]) => lines.flatMap(l => l.replace(/^\.save\s+/, "").split(/\s+/)).filter(Boolean);

console.log("[기본] 최상위 넷 전압을 전부 저장한다 (실행 뒤 프로브를 꽂아도 그려지게)");
{
  const p = savePlan(["in", "OUT", "0", "N003"], [], [], []);
  ok(JSON.stringify(saved(p.lines)) === JSON.stringify(["v(in)", "v(out)", "v(n003)"]), "접지(0)는 빼고 소문자로", saved(p.lines).join(" "));
  ok(p.note === "", "줄인 것이 없으니 할 말도 없다");
  const many = savePlan(Array.from({ length: 100 }, (_, i) => "n" + i), [], [], []);
  ok(many.lines.length === 5 && many.lines.every(l => l.startsWith(".save ")), "한 줄에 24개씩 나눈다", `${many.lines.length}줄`);
}

console.log("\n[.meas] 측정이 읽는 벡터는 반드시 남긴다");
{
  const p = savePlan(["out"], [], [
    "tran vx FIND v(in) AT=1m",
    "ac bw WHEN vdb(mid)=-3",
    "tran d FIND v(a,b) AT=1m",
    ".meas tran ia AVG i(V1) FROM=0 TO=1m",
  ], []);
  const got = saved(p.lines);
  for (const want of ["v(out)", "v(in)", "v(mid)", "v(a)", "v(b)", "i(v1)"]) ok(got.includes(want), `${want} 를 저장한다`);
  ok(savePlan(["out"], [], ["tran x FIND par('v(out)*2') AT=1m"], []).lines.length === 0, "par() 식은 못 읽으므로 줄이지 않는다");
}

console.log("\n[줄이지 않는 경우] 무엇이 필요한지 확신할 수 없으면 예전처럼 전부 저장한다");
{
  ok(savePlan(["out"], [], [], [block(["R9 out x 1k"])]).lines.length === 0, "지시문 블록에 소자 줄이 있다 (회로도에 없는 노드)");
  ok(savePlan(["out"], [], [], [block([".save all"])]).lines.length === 0, "지시문 블록에 .save 가 있다 (사용자의 뜻)");
  ok(savePlan(["out"], [], [], [block([".control", "run", ".endc"])]).lines.length === 0, ".control 블록이 있다");
  ok(savePlan(["out"], [], [], [block([".meas tran x MAX v(q)"])]).lines.length === 0, "블록 안의 .meas 는 읽지 않으므로 줄이지 않는다");
  ok(savePlan(["out"], [], [], [block(["R9 out x 1k"], false), block(["* note", ".param r=1k", ".model D1 D(IS=1e-14)"])]).lines.length > 0,
     "꺼 둔 블록 · 주석 · .param · .model 은 상관없다");
}

console.log(`\n[큰 회로] 넷이 ${MANY_NETS}개 이상이고 프로브가 있으면 프로브한 넷만`);
{
  const nets = Array.from({ length: MANY_NETS + 5 }, (_, i) => "n" + i);
  const p = savePlan(nets, ["n7", "N7", "n9"], ["tran x MAX v(n100)"], []);
  ok(JSON.stringify(saved(p.lines)) === JSON.stringify(["v(n7)", "v(n9)", "v(n100)"]), "프로브 + 측정이 읽는 것만", saved(p.lines).join(" "));
  ok(/probed/.test(p.note) && p.note.includes(String(nets.length)), "줄였다는 것을 알린다", p.note);
  const np = savePlan(nets, [], [], []);
  ok(saved(np.lines).length === nets.length, "프로브가 없으면 전부 저장한다 (무엇을 볼지 모른다)");
}

console.log("\n[동작점] .op 는 줄이지 않는다 (표에 가지 전류도 보여 준다)");
{
  ok(savePlan(["in", "out"], [], [], [], "op").lines.length === 0, ".op 이면 .save 를 붙이지 않는다");
  ok(savePlan(["in", "out"], [], [], [], "dc").lines.length > 0, ".dc · .ac · .tran 은 줄인다");
}

console.log("\n[넣는 자리] .end 바로 앞");
{
  const n = beforeEnd("* t\nR1 a 0 1k\n.tran 1u 1m\n.end", [".save v(a)"]);
  ok(n === "* t\nR1 a 0 1k\n.tran 1u 1m\n.save v(a)\n.end", ".save 가 해석 줄 뒤, .end 앞에 들어간다");
  ok(beforeEnd("x\n.end", []) === "x\n.end", "넣을 것이 없으면 그대로");
}

console.log(fail === 0 ? "\n.save 규칙 검증 통과" : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
