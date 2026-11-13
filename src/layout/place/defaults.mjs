/** 자동 배치의 기본값 — Placement 의 설정 칸이 이것으로 시작하고, 검사(tools/e2e-*.ts)도 이것으로 배치한다. 사람이 누르는
 *  Auto place 와 다른 설정으로 시험하면, 시험에서는 배선되는데 앱에서는 안 되는 배치를 못 잡는다 (Current-mirror OTA 가 그랬다).
 *  batch: 한 번에 해 보는 후보 수, perConfig: 변형 조합마다 시작점 수 (place/job.mjs). */
export const PLACE_DEFAULTS = Object.freeze({ batch: 96, perConfig: 32 });
