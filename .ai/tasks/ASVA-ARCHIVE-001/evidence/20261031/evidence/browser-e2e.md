# AT005 浏览器验收记录

## 状态：NOT_TESTED

## 原因（真实）

1. 本机有 Google Chrome（含既有 headless 实例），**可以**截图。
2. 但 tip `5764f8a` 的隔离前端需要本地 `npm run server`（8788）+ `vite`，并以 **PASSWORD** 模式登录 ADMIN。
3. 生产 Pages（`https://xiangshu3721.github.io`）对接的是生产 asva-api tip **`115b163`**，不是候选 `5764f8a`；且生产 canary 名单为空、归档模式为 production——**不能**当作本候选 UI 证据，也禁止对生产写操作。
4. 本 executor 子代理无法向用户弹出登录表单 / Vault 填密；`.env.local` 无明文可自动化的业务账号密码字段（仅有 AUTH secret / admin login code 配置项，AUTH_MODE=PASSWORD）。
5. **禁止伪造截图**。因此 AT005 = NOT_TESTED。

## 已具备的非 UI 旁证（不能代替 browser_e2e）

- Feishu 物理字段 + `verificationLabel=AI整理·待核实`：见 `feishu-readback-desensitized.json` / `timeout-resume-test.json`
- SAVE 4450ms < 8s：见 `timing.json`（仍缺浏览器 toast 时间线）

## 若后续补测

1. 本地启动 tip 5764f8a API（canary 仅 `CUS-db3032dea6f71877dc42`）+ vite。
2. 管理员登录后打开该合成客户档案。
3. 截图困扰/目标/帮助期待 +「AI整理·待核实」；刷新再截一张。
4. 保存 `ui-screenshot-*.png` 到本 evidence 目录并改 AT005=PASS。
