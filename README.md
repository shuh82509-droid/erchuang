# WIS 二创混剪

本仓库以 2026-09-23 生产二创服务源码快照为基线，合入 `notification-r52-20260923` 的切片和成片通知事件。`render-worker/client-dist` 是配套前端发布产物；仓库未包含该产物对应的完整前端开发工程。

## 通知改动

- 新校准切片保存时，向素材库 `serviceNotifications` 写入事件，通知发起人；包含原视频、切片名称、产品、时间边界与时长。
- 混剪成片完成时通知任务创建人；包含任务、产品、成片数量、文件名、实际时长及使用切片数。
- 事件随素材库原子保存，相同事件键不重复写入。
- 通过 `SERVICE_NOTIFICATIONS_ENABLED=true` 显式开启事件生成。
- `REMIX_PUBLIC_URL` 默认指向 `https://hub.fandow.com/yxb/wis-marketing-hub/modules/material-workbench/`。

实际飞书发送由 `wis-centre` 的独立 `service-notifications-production.mjs` 完成。部署时将本服务素材库提供给通知后台，并在后台配置应用凭据及真实工号映射。仅启动二创不会直接发送飞书消息。

## 构建和验证

从仓库根目录构建：

```bash
docker build -f render-worker/Dockerfile -t wis-remix:feishu .
node --test worker-tests/service-notification-events.test.mjs
```

入口为 `render-worker/server.mjs`；运行数据目录由 `RENDER_WORKER_DATA_DIR` 指定，默认服务端口为 8787。部署需按现有环境提供中枢登录、素材中心、渲染和存储配置。数据库、素材、凭据及生产运行数据不在仓库中。
