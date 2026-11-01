# dsh-workbuddy-auto-updater

> 一个 [DeepSeek Harness](https://www.deepseek.com/harness)（DSH）本地插件：自动检查 npm 并更新 [`dsh-connect-workbuddy`](https://www.npmjs.com/package/dsh-connect-workbuddy)，全程可在 DSH 插件页面里管理，无需手动下载。

## 功能特性

- 定时从 npm 官方源检查 `dsh-connect-workbuddy` 最新版本
- 发现新版本才更新，版本相同自动跳过，不做无用操作
- 自动处理 pnpm 的 24 小时新版本等待期（`minimumReleaseAgeExclude`）
- 只替换文件，**不强制重启 DSH**，重启后新版本才生效
- 在 DSH 插件页面提供完整设置卡片：
  - 状态徽章（已是最新 / 已更新待重启 / 失败）
  - 当前版本与最新版本、上次检查时间
  - 自动检查开关
  - 检查间隔（6 / 12 / 24 / 48 小时）
  - 一键「立即检查」
  - 可展开的运行日志

## 工作原理

```
读取已装版本 → 请求 npm registry 最新版本 → 版本比较
   ├─ 相同：跳过
   └─ 有新版：更新 pnpm-workspace 排除项 → 调用 dsh CLI 安装 → 回读验证 → 写日志
```

更新通过 DSH 自带的 CLI 完成，等价于手动执行：

```bash
dsh plugin --profile desktop add dsh-connect-workbuddy@<version>
```

## 安装

### 方式一：本地安装（当前推荐）

克隆或下载本仓库到本地，然后在 DSH 中以本地路径安装（路径按实际位置调整）：

```bash
dsh plugin --profile desktop add file:../../plugins/dsh-workbuddy-auto-updater
```

安装后**完全退出并重新打开 DSH**，即可在插件页面看到本插件。

### 方式二：从 npm 安装（发布后可用）

```bash
dsh plugin --profile desktop add dsh-workbuddy-auto-updater
```

## 使用

1. 重启 DSH 后打开「插件 / Plugins」页面
2. 找到 **WorkBuddy 自动更新**，展开设置卡片
3. 按需开启自动检查、选择间隔，或点击「立即检查」手动触发
4. 点击「查看日志」可查看最近的运行记录

## 环境变量（可选）

一般情况下无需设置，插件会自动探测。需要自定义时可使用：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `DSH_CLI` | 显式指定 `dsh.cmd` 的完整路径 | 自动探测 |
| `DSH_HOME` | 自定义 DSH 主目录 | `~/.dsh` |
| `DSH_PROFILE` | 自定义 profile 名称 | `desktop` |

CLI 路径的自动探测顺序：`DSH_CLI` → Electron 的 `process.resourcesPath` → 可执行文件同级目录 → 常见安装目录（Program Files、LocalAppData 等）。

## 常见问题

**Q：更新后为什么没有立刻生效？**
A：本插件只替换磁盘上的文件，正在运行的 DSH 仍使用旧代码，完全重启 DSH 后新版本才会加载。

**Q：会影响我的账号和配置吗？**
A：不会。更新只替换插件程序文件，账号、模型目录等配置保存在独立的配置文件中，不会被改动。

**Q：检查失败怎么办？**
A：设置卡片会显示失败状态和原因，展开日志可查看详情。多数情况是网络问题，确认能访问 npm 后点「立即检查」重试即可。

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
