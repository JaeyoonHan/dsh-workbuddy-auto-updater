# dsh-workbuddy-auto-updater

> 一个 [DeepSeek Harness](https://www.deepseek.com/harness)（DSH）本地插件：自动检查 npm 并更新 [`dsh-connect-workbuddy`](https://www.npmjs.com/package/dsh-connect-workbuddy)，全程可在 DSH 插件页面里管理，无需手动下载。

## 功能特性

- 定时从 npm 官方源检查 `dsh-connect-workbuddy` 最新版本
- 发现新版本才更新，版本相同自动跳过，不做无用操作
- 自动处理 pnpm 的 24 小时新版本等待期（`minimumReleaseAgeExclude`）
- 只替换文件，**不强制重启 DSH**，重启后新版本才生效
- 在 DSH 插件页面提供完整设置卡片：
  - 状态徽章（已是最新 / 已更新待重启 / 失败）
  - 当前版本与最新版本、上次检查时间、上次更新时间
  - 自动检查开关
  - 检查间隔（6 / 12 / 24 / 48 小时）
  - 一键「立即检查」
  - 可展开的运行日志
  - 操作被拒绝或失败时明确提示，不静默吞错

## 工作原理

```
读取已装版本 → 请求 npm registry 最新版本 → 校验 + 版本比较
   ├─ 相同：跳过
   └─ 有新版：更新 pnpm-workspace 排除项 → 调用 dsh CLI 安装 → 回读验证 → 写日志
```

更新通过 DSH 自带的 CLI 完成，等价于手动执行：

```bash
dsh plugin --profile desktop add dsh-connect-workbuddy@<version>
```

## 安全模型

这个插件会**在你的机器上执行安装命令**，所以它的信任边界值得说清楚。

### 1. 本地路由的来源校验

插件的三个路由直接注册在 `ctx.webServer` 上，**不经过 DSH 网关的凭据校验**（`/api/*` 未授权会返回 401，而注册在同一监听器上的插件路由不会）。因此插件自带一道门禁，与官方 `dsh-connect-workbuddy` 采用的规则一致：

| 检查 | 规则 | 挡住什么 |
|---|---|---|
| `Host` | 必须指向请求实际到达的监听地址 | DNS rebinding |
| `Origin` | 存在时必须指向本机；缺省则放行（非浏览器客户端的正常形态） | 跨站页面发起的请求 |
| `Content-Type` | 写操作必须是 `application/json` | 跨站表单的「简单请求」 |

**这道门禁不是身份认证。** 能直接连到该端口的本地进程可以伪造任意请求头。它真正买到的保证是：**别人网页上的 JS 无法通过你的浏览器驱动这个插件**——而这是 0.1.0 真实存在的问题（任意来源的 `text/plain` POST 可以改配置、可以触发一次真实安装）。

### 2. 版本号的白名单约束

从 npm registry 拿到的版本号会同时进入 YAML 文件和一个子进程参数，所以它先经过严格 semver 校验（只允许数字、ASCII 字母、`.`、`-`），不合法直接丢弃、不进入任何下游。

安装命令**默认不经过 `cmd.exe`**：插件直接定位 Electron 可执行文件与 CLI 入口脚本，用 `ELECTRON_RUN_AS_NODE=1` 启动，参数不经任何 shell 二次解析，`&` 之类的元字符没有可被解释的位置。只有在找不到直连路径时才回退到 `.cmd` 启动器，而那时版本号已被上一条的校验证明是纯数字与点号。

### 3. 边界说明（请务必理解）

- 本插件**不做**身份认证，也**不**验证 npm 包的签名或来源可信度，它信任 `registry.npmjs.org` 的官方发布。
- 所有更新都通过 DSH 官方 CLI 执行，产物与手动执行 `dsh plugin add` 完全一致。
- 若你把 DSH 监听地址绑定到非回环地址，请自行确认该网段的可信度；本插件的门禁是浏览器侧的跨站防护，不是网络隔离。

## 安装

### 方式一：本地安装（当前推荐）

克隆或下载本仓库到本地，然后在 DSH 中以本地路径安装（路径按实际位置调整）：

```bash
dsh plugin --profile desktop add file:../../plugins/dsh-workbuddy-auto-updater
```

安装后**完全退出并重新打开 DSH**，即可在插件页面看到本插件。

### 方式二：从 npm 安装

```bash
dsh plugin --profile desktop add dsh-workbuddy-auto-updater
```

## 使用

1. 重启 DSH 后打开「插件 / Plugins」页面
2. 找到 **WorkBuddy 自动更新**，展开设置卡片
3. 按需开启自动检查、选择间隔，或点击「立即检查」手动触发
4. 点击「查看日志」可查看最近的运行记录

自动检查会在下次启动时判断是否已超过间隔，超过则立即补跑一次，因此**不需要保持 DSH 常开**。

## 环境变量（可选）

一般情况下无需设置，插件会自动探测。需要自定义时可使用：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `DSH_EXE` | 显式指定 DeepSeek Harness 可执行文件路径 | 自动探测 |
| `DSH_CLI_SCRIPT` | 显式指定 asar 内的 CLI 入口 `cli.js` | 自动探测 |
| `DSH_CLI` | 显式指定 `dsh.cmd` 启动器（回退用） | 自动探测 |
| `DSH_HOME` | 自定义 DSH 主目录 | `~/.dsh` |
| `DSH_PROFILE` | 自定义 profile 名称 | `desktop` |

探测顺序：先找 Electron 可执行文件 + asar 内 CLI 脚本（无 shell），失败后回退到 `dsh.cmd` 启动器（经 `cmd.exe`）。

## 开发

```bash
npm test          # 安全原语单测：来源校验、CSRF、版本校验与比较
npm run test:e2e  # 端到端：重放越权攻击、验证 CLI 无 shell、模拟插件装载
npm run check     # 语法检查 + 单测
```

### 修改源码后如何让它生效

DSH 的 profile 用 `file:` 依赖 + `nodeLinker: hoisted`
（见 `~/.dsh/profiles/desktop/pnpm-workspace.yaml`），所以
`~/.dsh/profiles/desktop/node_modules/` 里是**实体副本**而不是符号链接，
DSH 运行时加载的正是那份副本。

因此改完 `~/.dsh/plugins/dsh-workbuddy-auto-updater` 里的源码后，
**必须同步到副本**，否则重启也不会生效：

```bash
# 先完全退出 DSH
powershell -ExecutionPolicy Bypass -File scripts/sync-to-profile.ps1
```

脚本会逐文件比对哈希并报告不一致，避免「以为更新了其实没更新」。
（`state.json` 与 `logs/` 是运行期数据，不会被同步覆盖。）

## 常见问题

**Q：更新后为什么没有立刻生效？**
A：本插件只替换磁盘上的文件，正在运行的 DSH 仍使用旧代码，完全重启 DSH 后新版本才会加载。

**Q：会影响我的账号和配置吗？**
A：不会。更新只替换插件程序文件，账号、模型目录等配置保存在独立的配置文件中，不会被改动。

**Q：检查失败怎么办？**
A：设置卡片会显示失败状态和原因，展开日志可查看详情。多数情况是网络问题，确认能访问 npm 后点「立即检查」重试即可。

**Q：为什么卡片上的按钮点了没反应？**
A：0.2.0 起，被拒绝的请求会在卡片上显示原因（例如来源校验未通过）。若持续失败，展开日志查看具体错误。

## 更新日志

### 0.2.0

安全加固版本。**升级后请完全重启 DSH。**

- **修复越权**：路由增加 Host + Origin 校验与 `application/json` 强制要求，跨站请求不再能改配置或触发安装
- **修复命令注入面**：版本号强制 semver 白名单校验；安装默认走 `ELECTRON_RUN_AS_NODE` 直连调用，不经过 `cmd.exe`
- **修复版本比较**：预发布版本不再被误判为更新
- **修复定时逻辑**：启动时按「距上次检查已超过间隔」补跑一次，短暂开机也能更新
- **修复排除项替换**：`minimumReleaseAgeExclude` 的正则锚定到本包名，不再可能误改其他条目
- **修复重复渲染**：不再向 `plugins.row.config` 用错误的 key 重复注册同一张卡片
- **健壮性**：状态文件改为原子写；日志写入失败不再被静默吞掉；请求体限制 64 KB
- **可观测性**：卡片新增「上次更新时间」与失败原因提示
- **工程化**：补齐 `scripts.test` / `scripts.check` 与 13 项单测 + 2 个端到端验证脚本

### 0.1.0

首个版本。

## 第三方声明与免责

- 本插件是**第三方非官方工具**，与 `dsh-connect-workbuddy` 及其作者、DeepSeek 官方**没有任何关联、背书或担保关系**。
- 本插件**不包含、不镜像、不重新分发** `dsh-connect-workbuddy` 的任何代码，始终从 npm 官方 registry 安装其官方发布包，行为等同于依赖自动更新（类似 Dependabot）。
- 「WorkBuddy」「DeepSeek Harness」等名称及相关商标归各自所有者所有，本项目仅在描述功能时引用。
- 本插件按「现状」提供，不附带任何明示或暗示的担保，使用者自行承担风险。

## 致谢

- [`dsh-connect-workbuddy`](https://www.npmjs.com/package/dsh-connect-workbuddy) — 作者 dingminhua，MIT 许可证
- DeepSeek Harness / Cordis 插件框架

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
