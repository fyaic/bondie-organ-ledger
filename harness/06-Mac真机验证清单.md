# 06-Mac 真机验证清单（人类在 Mac 上执行）

> 执行者 AI 在 Windows 上完成代码加固后，**产出/校对本清单**，人类拿到 Mac 上照单验证。
> 目的：证明「代码级加固」在真实 macOS 上跑通核心流程、且哈希链与 Windows 一致。
> 用独立家目录，别弄脏默认 `~/.organledger`（参考既有约定：用 `--home ~/.organledger-macdemo`）。

> ⚠️ **情况反转说明（2026-07-15）**：本次执行者实际在 **macOS**（Darwin 25.5.0, Node v26）上完成代码加固，
> 不是计划假设的 Windows。因此下面「验证 2 测试全绿」已由执行者在 Mac 上**预先跑通**（见 ✅），
> 且额外修复了一个 Windows 参谋长看不到的 **macOS 专属 BLOCKER**（`provenance.ts` 符号链接路径失配，
> 详见 `99-执行偏差日志.md` 跨平台异常 #1）。**现在真正待人类验证的反而是 Windows 侧** + 已 push 后的 CI 三矩阵。
> Mac 侧命令仍建议人类照单复跑一遍作为独立确认。

## 前置
```bash
node --version          # 需 ≥ v24
git --version
cd ~/path/to/organledger
git checkout feat/cross-platform
git pull                # 或从 Windows 同步该分支
```

## 验证 1：换行/哈希链一致性（最关键）
```bash
# clone 后确认工作区是 LF（.gitattributes 生效）
file src/util.ts                       # 期望不显示 "CRLF"
git ls-files --eol | grep -v 'lf' | grep 'w/' || echo "all LF ✓"
```
- [ ] 所有文本文件工作区为 LF
- [ ] `git status` 干净（无因换行产生的杂散 diff）

## 验证 2：测试全绿
```bash
node --test test/*.test.ts
```
- [x] ✅ 执行者已在 Mac 跑通：**90 pass / 0 fail / 0 skip**（本机装了 python3，hermes 正常 pass；缺 python 时会 skip 非 fail）
- [ ] 全部 pass（python 缺失的话 hermes 应为 skip 非 fail）
- [ ] 记录 pass/skip/fail 数，与 Windows 本机结果对比应一致

## 验证 3：init + daemon 生命周期
```bash
node src/cli/index.ts init --home ~/.organledger-macdemo   # 按提示走
node src/cli/index.ts daemon --home ~/.organledger-macdemo &
sleep 2
# 触发一次器官改动（对被治理的 home 写点东西），观察账本
node src/cli/index.ts report --home ~/.organledger-macdemo
```
- [ ] daemon 正常起、写 `state/daemon.lock`
- [ ] Ctrl-C（SIGINT）能优雅关闭并释放 lock（`ls ~/.organledger-macdemo/state/daemon.lock` 应消失）
- [ ] 账本 tickets.jsonl 有记录，哈希链校验通过

## 验证 4：dashboard + reveal
```bash
node src/cli/index.ts dashboard --home ~/.organledger-macdemo --port 7377
# 浏览器开 http://localhost:7377
```
- [ ] dashboard 正常渲染
- [ ] reveal「在 Finder 中显示」用 `open -R` 正常打开并选中文件
- [ ] 越界路径被 403 拦截（安全门正常）

## 验证 5：跨平台哈希一致性（黄金验证）
> 这是证明 BLOCKER 真被修好的决定性一步。
```bash
# 在 Mac 上对某个器官文件计算 fileSha，与 Windows 上对同一内容的 fileSha 对比
# 同一 LF 内容 → 两平台 sha256 必须相同
```
- [ ] Mac 与 Windows 对**同一 LF 文件内容**产出**相同的 sha256**
- [ ] 若不同 → 说明仍有 CRLF 泄漏，回填 `99-偏差日志`，是 BLOCKER 未闭环

## ⏳ 本次不验证（二期）
- launchd 自启动（`autostart.ts` 仅输出 `.plist` 模板，本次范围外）

## 结果回填
人类跑完把结果贴回 `99-执行偏差日志.md` 或直接告知；任一项 ❌ → 对应任务未闭环。
