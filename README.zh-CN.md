# RA2 VM

[English](README.md) | [简体中文](README.zh-CN.md)

![开发阶段：Alpha](https://img.shields.io/badge/status-Alpha-orange)
[![运行时：v86](https://img.shields.io/badge/runtime-v86-5c4ee5)](docs/ARCHITECTURE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](package.json)
[![许可证：GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)

在浏览器中直接运行《红色警戒 2》和《尤里的复仇》的原版 x86 程序。
项目基于 v86、自定义固件和 Win32/DirectX 兼容层，不启动 Windows。

_⚠️EA 并未认可且不支持此产品。_

**在线体验：[ra2.games](https://ra2.games)**

当前为 Alpha：支持本地资源导入、RA2/YR 选择、遭遇战入口、存档、地图包和自建
WebSocket relay 联机。双人短局回归不代表所有战役、MOD、多人大规模交战或公网长局兼容。

## 开始游戏

1. 打开 [ra2.games](https://ra2.games)，准备好你合法持有的 RA2 或 YR 游戏资源。
2. 点击「选择文件…」导入本地压缩包，或点击「选择文件夹…」选择游戏目录。
   资源包需包含原始游戏主程序。页面会检查资源完整性，缺少必需文件时会列出缺项。
3. 只有一个完整版本时自动启动；同时包含 RA2 和 YR 时，选择要玩的版本。
4. 进入原版游戏界面后，可从「单人游戏」进入「遭遇战」，选择地图、阵营和电脑对手后开始。

网页在打开时按浏览器首选语言自动选择英文或简体中文，其他语言回退英文。游戏内文字由导入资源的语言决定。

排查游戏变慢时，可在游戏工具栏打开「性能诊断…」，采样 20 秒后复制报告。
操作和指标说明见[浏览器对比报告](docs/GAME_PERFORMANCE.md#browser-comparison-reports)。

## 与朋友联机

### 1. 部署联机 relay

relay 负责在浏览器之间转发联机数据，由一位玩家或服务器管理员部署，其他玩家连接同一地址和房间路径。

在装有 Docker 和 Docker Compose 的服务器上取得本仓库，从仓库根目录运行：

```bash
docker compose -f packages/relay/compose.yaml up -d --build
docker compose -f packages/relay/compose.yaml logs -f relay
```

服务监听 TCP **15176**，支持自动重启，并提供 `/healthz` 健康检查。服务器防火墙需放行所用 TCP 端口。
局域网玩家填写服务器可达的内网 IP 和映射端口；`0.0.0.0` 只是监听地址，不能作为连接地址。

通过公网 IP 或域名连接时，需要在 relay 前部署带有效证书、支持 WebSocket Upgrade 的 TLS 反向代理，
将 `/ra2` 等房间路径转发到 relay。游戏前端对公网地址使用 **WSS**，对内网和回环地址使用 **WS**；
访问私网仍需遵守浏览器权限要求。地址选择、独立分发和配置详见 [relay 部署说明](packages/relay/README.md)。

本地开发也可以不用 Docker：

```bash
pnpm install --frozen-lockfile
pnpm run server:relay --host 0.0.0.0 --port 15176
```

构建独立服务端：

```bash
pnpm run build:relay
node packages/relay/dist/gameRelay.cjs --host 0.0.0.0 --port 15176
```

静态网页构建不包含 relay 服务端。如果站点已经提供同源 relay，玩家可以留空地址，直接使用该服务。

### 2. 连接并开始对局

1. 所有玩家打开在线页面，在选择资源、启动游戏前勾选「联机」。
2. 填写部署好的 relay 主机地址和端口，默认房间为 `/ra2`。也可带上路径，例如同机测试使用
   `127.0.0.1:15176/friends`。所有玩家须使用相同地址和路径；留空表示使用站点默认 relay。
3. 各自导入资源并启动同一款游戏。双方的游戏版本、MOD 和地图应一致，RA2 与 YR 不能混联。
4. 在原版主菜单进入「网络」，确认页面联机状态已连接，并在原生大厅中看到其他玩家。
5. 房主创建游戏，选择地图和设置；其他玩家选择房间并加入。等待地图校验完成，
   加入者确认准备就绪后，由房主开始游戏。

看不到朋友或房间时，检查联机开关、relay 地址、房间路径和游戏版本。
联机设置保存在页面 URL 中，可分享当前地址；修改设置前先结束游戏。
成员数表示同一虚拟局域网的其他连接数，RTT 是到中继的往返延迟，不等于玩家之间的延迟。
当前不支持断线续局；连接中断后需重新开局。更多边界见 [联机说明](docs/RA2_NETWORK_RELIABILITY.md)。

## 运行与开发

内部开发在 `dev` 分支进行，不推送 GitHub；外部贡献请向 `main` 提交 PR。
使用 Node.js 和 `package.json` 指定的 pnpm，不对 Node 设置版本范围限制。

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

打开终端给出的 HTTPS 地址，选择本地游戏文件夹或压缩包。应用先检查资源：
只有一个完整版本时自动启动，同时包含 RA2/YR 时再选择游戏。资源包需包含原始
`game.exe`（RA2）或 `gamemd.exe`（YR）。导入和缓存恢复保留包内主程序，不再下载替代 EXE。
游戏程序与资源不包含在本仓库中，公共测试不需要它们。

```bash
pnpm run check          # 类型、无素材单元/合成 VM 测试、生产构建
pnpm run build          # 静态页面输出到 dist/
pnpm run preview        # 预览构建结果
pnpm run server:relay:dev  # 监听源码变更；重启会断开现有连接
```

开发者自备的完整资源可放在被忽略的 `game/ra2/`，详见 [测试指南](docs/TESTING.md)。
首次使用 pnpm 的安装方式和可用 Node 环境由开发环境提供；CI 输出实际工具链版本。

## 文档与贡献

- [架构设计](docs/ARCHITECTURE.md)：模块边界、数据流与所有权。
- [贡献指南](CONTRIBUTING.md)：开发、验证和 PR 要求。
- [测试与 CI](docs/TESTING.md)：无素材准入和真实游戏测试。
- [CI 资源配置](docs/REAL_GAME_CI.md)：下载地址 secret、哈希与 runner 隔离。
- [游戏性能](docs/GAME_PERFORMANCE.md)：真实逻辑 FPS 和联机测量。
- [文档索引](docs/README.md)：资源、界面、Worker、启动与超分专题。

- [Relay 协议](packages/relay/RELAY_PROTOCOL.md)：独立 relay 的线协议。

## 许可证

项目原创代码采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。你可以按照 GPL 第 3 版
或任何后续版本的条款使用、修改和分发这些代码；软件不提供任何担保。
第三方代码、依赖和游戏素材保留各自许可，不因仓库许可证改变归属。
来源和适用边界见 [第三方说明](docs/THIRD_PARTY.md)。
