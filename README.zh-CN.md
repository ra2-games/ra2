> EA has not endorsed and does not support this product.
>
> EA 并未认可且不支持此产品。

<img align="right" src="https://qr1.ra2.games/s/40b87fac.svg" alt="微信群二维码" title="微信交流群" width="80" height="80" />

<h1>RA2 VM</h1>

<br clear="right" />

<p align="center">
  <a href="README.md">English</a> / <strong>简体中文</strong>
</p>

<p align="center">
  <img alt="开发阶段：Alpha" src="https://img.shields.io/badge/status-Alpha-orange?style=flat-square" />
  <a href="docs/ARCHITECTURE.md"><img alt="运行时：v86" src="https://img.shields.io/badge/runtime-v86-5c4ee5?style=flat-square" /></a>
  <a href="package.json"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&amp;logoColor=white&amp;style=flat-square" /></a>
  <a href="package.json"><img alt="pnpm" src="https://img.shields.io/badge/pnpm-F69220?logo=pnpm&amp;logoColor=white&amp;style=flat-square" /></a>
  <a href="LICENSE"><img alt="许可证：GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square" /></a>
</p>

<p align="center">
  <img src="docs/assets/ra2vm-poster.jpg" alt="RA2 VM 浏览器运行展示" width="100%" />
</p>

<p align="center">
  🎮<a href="https://ra2.games"><strong> https://ra2.games</strong></a>
  &nbsp;·&nbsp;
  📧 <a href="mailto:contact@ra2.games">contact@ra2.games</a>
</p>

<p align="center">
  在浏览器中直接运行《红色警戒 2》和《尤里的复仇》，基于 v86、自定义固件和 Win32/DirectX 兼容层，无需启动 Windows。
  《心灵终结 3.3.6》通过资源包自带的 Syringe/Ares 启动，目前仍属实验性支持。
</p>

> **当前为 Alpha：**支持导入本地游戏资源、选择 RA2 或 YR、进入遭遇战、
> 读取存档和地图包，并通过 WebSocket relay 联机。

<p align="center">
  <img src="public/images/factions/allies.png" alt="盟军" width="80" />
  &nbsp;
  <img src="public/images/factions/soviets.png" alt="苏联" width="80" />
  &nbsp;
  <img src="public/images/factions/yuri.png" alt="尤里" width="80" />
  &nbsp;
  <img src="public/images/factions/foehn.png" alt="焚风" width="80" />
</p>

## 浏览器实机画面

<table align="center" width="100%" cellpadding="4" cellspacing="0">
  <tbody>
    <tr>
      <td align="center" valign="top" width="25%">
        <p><strong>RA2 · 战役</strong></p>
        <a href="docs/assets/ra2-campaign.jpg"><img src="docs/assets/ra2-campaign.jpg" alt="红色警戒 2 原版战役在 Chrome 浏览器中运行" width="100%" /></a>
      </td>
      <td align="center" valign="top" width="25%">
        <p><strong>RA2 · 遭遇战</strong></p>
        <a href="docs/assets/ra2-gameplay.jpg"><img src="docs/assets/ra2-gameplay.jpg" alt="红色警戒 2 原版遭遇战在 Chrome 浏览器中运行" width="100%" /></a>
      </td>
      <td align="center" valign="top" width="25%">
        <p><strong>YR · 战役</strong></p>
        <a href="docs/assets/yr-campaign.jpg"><img src="docs/assets/yr-campaign.jpg" alt="尤里的复仇战役在 Chrome 浏览器中运行" width="100%" /></a>
      </td>
      <td align="center" valign="top" width="25%">
        <p><strong>YR · 遭遇战</strong></p>
        <a href="docs/assets/yr-gameplay.jpg"><img src="docs/assets/yr-gameplay.jpg" alt="尤里的复仇遭遇战在 Chrome 浏览器中运行" width="100%" /></a>
      </td>
    </tr>
  </tbody>
</table>

## 开始游戏

### 红色警戒 2 / 尤里的复仇

1. 打开在线站点，准备好你合法持有的游戏资源。点击「获取资源」，在弹出的模态框中查看原版购买与 MOD 下载链接。
2. 点击「加载资源」，在弹出的模态框中选择本地压缩包或游戏文件夹。
   资源包需包含原始游戏主程序。页面会检查资源完整性，缺少必需文件时会列出缺项。
3. 在上传模态框内选择 RA2 或 YR，点击「启动游戏」。资源不足的版本会显示缺项；导入后不会自动启动。
4. 进入原版游戏后，打开「单人游戏 → 遭遇战」，选择地图、阵营和电脑对手后开始。

<a id="mental-omega"></a>

### 心灵终结 3.3.6（实验性）

点击「加载资源」，在同一个模态框中加载尤里的复仇资源，并添加 MO 3.3.0 基础压缩包及必需的 3.3.6 更新补丁。两个包可同时选择，顺序不限，
无需手动解压。可点击各标题旁的「没有资源？点击获取」打开对应页面，也可在「获取资源」模态框中查看全部链接。单独添加扩展包后仍可运行原版 YR；也可直接导入完整 MO 安装目录。
请保留资源包自带的 `Syringe.exe`、Ares 和 CnCNet 模块。导入后选择任务或地图，运行环境会执行原始注入器及其兼容性检查。
详见[下载与安装引导](docs/MENTAL_OMEGA_INSTALL.md)。

菜单支持直接加载网页存档。
页面会根据浏览器首选语言选择英文或简体中文，其他语言回退为英文；游戏内文字由导入资源的语言决定。

排查游戏变慢时，可在游戏工具栏打开「性能诊断…」，采样 20 秒后复制报告。
详见[浏览器对比报告](docs/GAME_PERFORMANCE.md#browser-comparison-reports)。

## 与朋友联机

所有玩家须使用相同且可达的 relay 地址和房间路径，并使用相同游戏版本、
MOD 和地图。RA2 与 YR 不能混联。

1. 所有玩家打开在线页面，在导入资源或启动游戏前勾选「联机」。
2. 填写 relay 主机地址和端口。默认房间为 `/ra2`；可添加路径创建其他房间，
   例如 `127.0.0.1:15176/friends`。所有玩家须使用相同地址和路径。只有站点
   已提供同源 relay 时，才可以留空地址。
3. 导入相同资源后，在原版游戏中打开「网络」。房主创建游戏，其他玩家加入并
   等待地图校验；所有人准备就绪后由房主开始。

看不到朋友或房间时，检查联机开关、relay 地址、房间路径和游戏版本。

Docker、独立 Node 服务端、防火墙和公网 WSS 配置见
[relay 部署指南](packages/relay/README.md)。静态网页构建不包含 relay 服务端。

联机设置会保存在页面 URL 中；修改设置前先结束游戏。成员数表示同一虚拟
局域网中的其他连接数，relay RTT 是到中继的往返延迟，不代表玩家之间的延迟。连接中断后无法续局，
需重新开局。详见[联机限制](docs/RA2_NETWORK_RELIABILITY.md)。

## 实验性 AI agent / skill 接入

仓库已提供 [ra2-strategy](.agents/skills/ra2-strategy/SKILL.md)，负责经济、侦察、
防守与作战决策；[ra2-battle-control](.agents/skills/ra2-battle-control/SKILL.md)
负责原生玩家操作、监测与结果确认。两者通过 `ra2ctl` 共用每个频道的单一指令发送者。

在不同终端启动开发页面和 `pnpm ra2ctl serve`，导入资源后选择「连接 AI」，
频道填写 `1`。安装并登录 Codex CLI 或 Claude Code 后，在另一终端任选一个启动：

```bash
pnpm ra2agent --agent codex --channel 1
# 或改用 Claude Code 控制该频道：
pnpm ra2agent --agent claude --channel 1
```

默认接入已有对局；添加 `--quick-start` 可允许在没有进行中对局时开局。
战况读取仅覆盖当前镜头内、原生玩家视角可见的信息，并按战争迷雾与隐蔽状态过滤。
指令遵循原版的生产、放置、寻路与战斗规则。

此功能仍属实验性质，要求 RA2/YR 主程序匹配控制接口的指令与内存布局检查，暂不覆盖 MO 控制。
配置、能力与验证范围见[本地 AI 控制指南](docs/AI_CONTROL.md)。

## 与 Chrono Divide 对比

RA2 VM 运行原始游戏主程序；Chrono Divide 使用 Web 技术重新实现 RA2 引擎。
两种路线的兼容范围有所不同。

| 对比项 | RA2 VM | Chrono Divide |
| --- | --- | --- |
| 核心原理 | v86 模拟 x86，自定义固件与 Win32/DirectX 兼容层运行原始 EXE，无需启动 Windows | 为浏览器重新实现游戏引擎，目标是达到原版 RA2 的功能覆盖 |
| 原版战役 | 可运行 RA2 和 YR 战役 | 本次查阅的官方资料未公布支持 |
| 尤里的复仇 | 支持，运行原始游戏主程序 | 未公布完整资料片支持；已实现部分 YR 便利功能 |
| 心灵终结 | 通过自备 Syringe/Ares 原生启动 MO 3.3.6，仍属实验性支持 | 未公布 MO 支持 |
| 路径点指令 | 沿用原版游戏指令逻辑 | 支持路径点指令队列 |
| 循环路径点 | 支持 | 本次查阅的官方资料未确认 |
| 保存 / 读档 | RA2/YR 存档；MO 存档兼容性需单独验证 | 支持录像；未确认原版游戏存档兼容性 |
| 多人联机 | 原版「网络」菜单通过 WebSocket relay 联机，要求版本与资源一致 | 浏览器联机，支持快速匹配与天梯 |
| 对局录像 | 暂未提供浏览器录像功能 | 支持 |
| AI agent / skill 接入 | 实验性 RA2/YR 策略与战场控制 skill，提供专用 agent 启动入口 | 提供 Game API 与 bot 开发示例；未确认 agent skill 封装 |

对比范围：Chrono Divide 官方 About/Features 与 `patch-notes.html`，截至
v0.84.0（2026 年 9 月 3 日），查阅于 2026 年 10 月 15 日；不包含社区衍生版本。
AI 接口参考：Chrono Divide `game-api-playground`，`master`，`README.md`。
「未确认」不等于不支持。
可运行战役不代表已验证全战役通关。MO 仍属实验性支持，启动验证不代表完整战役或联机验证，详见
[MO 指南](docs/MENTAL_OMEGA_INSTALL.md)。RA2 VM 的实现与联机范围见
[架构设计](docs/ARCHITECTURE.md)和[联机限制](docs/RA2_NETWORK_RELIABILITY.md)。

## 运行与开发

内部开发在 `dev` 分支进行，不推送 GitHub；外部贡献请向 `main` 提交 PR。
使用 Node.js 和 `package.json` 指定的 pnpm；项目不固定 Node 版本范围。
首次构建 CPU 还需要 Rust 及其 `wasm32-unknown-unknown` 目标、clang、lld、make、git 和 Python 3，
详见 [CPU 构建说明](scripts/vm/README.md)。

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

打开终端给出的 HTTPS 地址，选择本地游戏文件夹或压缩包。资源包需包含原始
`game.exe`（RA2）或 `gamemd.exe`（YR）。导入和缓存恢复会保留该主程序，不会
下载替代 EXE。原版游戏主程序和安装资源包不包含在仓库中，公共测试不需要它们。

导入资源完成解压后会保存在当前浏览器，包括尚未补齐的资源和独立 MO 扩展包。
刷新后恢复资源准备状态，在“加载资源”中选择版本并点击“启动游戏”即可运行。
上传弹窗中的“清除缓存”会移除导入资源，保留存档和自定义地图。
存储失败会在上传弹窗中显示。

```bash
pnpm run check             # 类型、无素材单元/合成 VM 测试、生产构建
pnpm run build             # 静态页面输出到 dist/
pnpm run preview           # 预览构建结果
pnpm run server:relay:dev  # 监听源码变更；重启会断开现有连接
```

开发者自备的完整资源可放在被忽略的 `game/ra2/` 目录，详见
[测试指南](docs/TESTING.md)。

## 文档与贡献

**玩家指南：**[本地 AI 控制](docs/AI_CONTROL.md) ·
[游戏性能](docs/GAME_PERFORMANCE.md) ·
[联机限制](docs/RA2_NETWORK_RELIABILITY.md)

**开发者指南：**[架构设计](docs/ARCHITECTURE.md) ·
[贡献指南](CONTRIBUTING.md) · [测试与 CI](docs/TESTING.md) ·
[真实游戏 CI](docs/REAL_GAME_CI.md) · [文档索引](docs/README.md) ·
[Relay 协议](packages/relay/RELAY_PROTOCOL.md) ·
[第三方说明](docs/THIRD_PARTY.md)

## 运行环境与兼容性说明

> **项目范围：**本项目提供用于运行用户自备游戏的浏览器运行环境，不提供破解、密钥生成、伪造认证结果或绕过原程序保护检查的功能，也不随源码分发游戏安装文件。请导入您合法持有的完整硬盘安装；原程序要求的安装数据与授权条件仍须满足。

> **兼容性边界：**运行环境包含 x86 模拟、Win32/DirectX 兼容层及运行时内存适配。内存适配用于提供 AI 控制、快速启动和游戏性能优化，不用于改写游戏的玩法规则；AI 操作仍通过原生指令处理和规则检查。适配会调整部分启动流程、等待和联机时序，因此不表示执行流程完全不变。用户的源安装文件不会被改写，原程序的保护检查不会被跳过，也不保证所有版本均可运行。

> **RA2 / YR 启动：**导入完整安装文件夹或压缩包。存在配套启动器和配置（RA2 的 `ra2.exe` / `ra2.lcf`，YR 的 `ra2md.exe` / `ra2md.lcf`）时运行该启动器；两者均不存在时尝试直接运行游戏主程序。配套文件不完整或读取失败会报错。`Conquer.dat` / `ConquerMD.dat` 存在时会导入，缺失时由原程序决定如何处理。版本不按 EXE 哈希白名单筛选；原程序检查或不支持的行为失败时，不通过切换路径规避。心灵终结运行资源包自带的 Syringe/Ares，保留其原生兼容性判定。详见[启动边界](docs/ARCHITECTURE.md#native-launcher-and-installation-boundary)。

## 许可证

生产构建包含[第三方许可与对应源码材料](public/licenses/index.html)。

项目原创代码采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。你可以按照 GPL 第 3 版
或任何后续版本的条款使用、修改和分发；软件不提供任何担保。第三方代码、
依赖和游戏素材保留各自许可和归属，详见[第三方说明](docs/THIRD_PARTY.md)。
