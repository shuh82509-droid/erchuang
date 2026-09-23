# Worker 发布前续跑审查与修复

范围：当前任务的 render-worker 候选；无生产修改、无外部业务消息、无模型调用。

## 复现并修复

1. 人工确认的自动批次成片：原 `automaticOutputStats` 将 `reviewStatus=approved`、`reviewMode=human`、`automaticAssessment.status=review_required` 算为 `approvedCount=0/rejectedCount=1`。现在计入原批次已通过数量，分别报告自动、人工、历史审核；不改写人工来源，也不设置 `autoApproved=true`。
2. 旧版本审核迁移：原有已通过成片缺少 `reviewMode`/视觉凭证时，续跑会覆盖状态为 `changes_requested`，备注变为“系统自动退回并重剪”。现在保留原状态、备注与时间，标记 `legacy` 来源。历史来源不计为 L4 自动内容复核；回传仍验证文件摘要，未登记摘要的历史成片需要重新人工审核。
3. 完整切片时长无解：五个必需角色各 20 秒、目标 45 秒，完整片段规划返回 `null`，但角色数量与可拼总时长充足使补源数为 0。现在在原 run 中保存 `sourceDurationGap`，下一轮有效源与常规源选择都使用受配置上限约束的补源数量；保存新的可行成片后清除标记。
4. 平台隔离审核：原 private-workflow 集成测试中的已隔离成片文件缺失，审核请求先访问文件而返回 400，覆盖了原应返回的 409 平台拒绝原因。现在先检查原快照的平台隔离，再检查文件；提交时仍复查最新隔离状态。

## 验证

- 新增 `auto-resume-state.test.mjs`：4 个用例通过，覆盖人工继续原批次、历史审核保留、自动/人工/历史来源与平台隔离、时长无解触发有界真实列表请求。
- 与原有 duration-plan、manual-output-integrity、visual-quality、source-selection、copy-fact-gate、output-quality 共 25/25 用例通过。
- 原有 `clip-remix-duration-test.mjs` 脚本通过。
- 原有 `private-workflow-test.mjs` 集成测试先复现 400 != 409；修复后通过，包含上传取消清理、私有权限、异步裁切、区间校验与重复操作。
- `node --check render-worker/clip-remix-service.mjs` 通过。
- 为导入真实服务模块，本地按既有 package-lock 安装了 busboy 1.6.0 与 streamsearch 1.1.0；无依赖版本或锁文件修改。

以上是本地候选验证。镜像需要重新构建；不等于生产发布或双品真实 L4 验收。视觉审核仍保留每批最多 4 次模型调用、结果不明不自动重发的原限制。真实源不足时继续保留原批次与缺口，不伪造合格片段。

## 安全启动补充修复

- 初始化不再把所有 `autoApproveOutputs` 强制设为 true，也不把等待补源的未来退避时间改为立即执行。
- 原 `awaiting_review` / `awaiting_clip_review` 保留审核等待；初始化和普通调度都不能替代审核决定。用户明确恢复原批次时写入一次恢复请求，开始处理后消费该请求。
- 已暂停或归档计划完全不变；关闭定时且未安排下一次运行的计划继续空闲。已执行但进程中断的原批次恢复为 queued，保留原 run、已产出的成片及来源引用。原本开启且到期的合法计划仍可调度。
- 创建、更新与渲染执行路径尊重显式关闭的自动审核。关闭时不调用视觉模型、不自动批准；成片按 `manual_pending` 保存，等待人工审核。
- 新增 `auto-startup-policy.test.mjs` 4 个用例；当前合计 29/29 通过。其中真实服务 initialize 在模拟 3 active / 18 paused 的状态上执行两次，未启动媒体任务，既有待审与无安排时间的计划保持等待，关闭的自动审核全部保留。

## 补库任务发布边界（只读审查）

当前补库接口仅允许受信服务 GET 查看、POST 创建/复用任务，连续供应线仅支持查看/唤醒，没有排空、暂停、恢复接口。`server.mjs` 未注册 SIGTERM/SIGINT 关闭流程，不能据此保证终止会等待当前资产提交。已完成资产有逐步持久记录；当前正在下载、识别、切片的资产仍存在被终止后重新尝试的可能。发布应等待补库运行数自然归零，或先建立受信排空机制；编码与 OCR 数量为 0 不等于补库已空。本次未修改或停止任何生产任务。
