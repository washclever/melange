/** 배치 워커 — 배치기(../place/job.mjs)를 워커에서 돌린다. 예제 하나가 수 초 ~ 수십 초라 메인 스레드면 화면이 언다.
 *  kind 가 "retry" 면 편집기의 위상 유지 variant 다시 고르기, 아니면 배치 한 판. */
import { runJob, runEdit } from "../place/job.mjs";

self.onmessage = (e) => (e.data?.kind === "retry" ? runEdit(e.data, (m) => postMessage(m))
                                                  : runJob(e.data, (m) => postMessage(m)));
