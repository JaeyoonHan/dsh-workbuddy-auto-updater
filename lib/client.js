window.__ModuleLoader__.load({
	id: "dsh-workbuddy-auto-updater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NAME = "dsh-workbuddy-auto-updater-client";
		const INJECT = ["slots", "locale"];
		const NS = "settings.workbuddy-updater";
		const PKG = "dsh-workbuddy-auto-updater";
		const BASE = "/plugins/dsh-workbuddy-auto-updater";
		const POLL_MS = 10_000;
		const CARD_KEYS = [PKG, "include:" + PKG];

		const zh = {
			"card.title": "WorkBuddy 自动更新",
			"card.current": "当前版本",
			"card.latest": "最新版本",
			"card.lastCheck": "上次检查",
			"card.never": "尚未检查",
			"card.auto": "自动检查",
			"card.interval": "检查间隔",
			"card.checkNow": "立即检查",
			"card.checking": "检查中…",
			"card.showLog": "查看日志",
			"card.hideLog": "收起日志",
			"card.status.up-to-date": "已是最新",
			"card.status.updated": "已更新（待重启）",
			"card.status.failed": "更新失败",
			"card.status.running": "检查中",
			"card.status.unknown": "未知",
			"card.hours": "小时",
			"card.hint": "自动检查 npm 并更新 dsh-connect-workbuddy，仅替换文件，重启 DSH 后生效"
		};
		const en = {
			"card.title": "WorkBuddy Auto Updater",
			"card.current": "Installed",
			"card.latest": "Latest",
			"card.lastCheck": "Last check",
			"card.never": "Never",
			"card.auto": "Auto check",
			"card.interval": "Interval",
			"card.checkNow": "Check now",
			"card.checking": "Checking…",
			"card.showLog": "Show log",
			"card.hideLog": "Hide log",
			"card.status.up-to-date": "Up to date",
			"card.status.updated": "Updated (restart)",
			"card.status.failed": "Failed",
			"card.status.running": "Running",
			"card.status.unknown": "Unknown",
			"card.hours": "hours",
			"card.hint": "Checks npm and updates dsh-connect-workbuddy. Files only; restart DSH to apply."
		};

		const STATUS_COLOR = {
			"up-to-date": "var(--dsw-static-green-500, #22c55e)",
			updated: "var(--dsw-static-blue-500, #3b82f6)",
			failed: "var(--dsw-static-red-500, #ef4444)",
			running: "var(--dsw-static-amber-500, #f59e0b)",
			unknown: "var(--dsw-alias-label-tertiary, #999)"
		};

		const fmtTime = (ms) =>
			typeof ms === "number"
				? new Date(ms).toLocaleString()
				: null;

		function Badge(props) {
			return react.createElement(
				"span",
				{
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 5,
						fontSize: 11,
						fontWeight: 600,
						color: props.color,
						padding: "2px 8px",
						borderRadius: 999,
						background: "color-mix(in srgb, " + props.color + " 14%, transparent)",
						whiteSpace: "nowrap"
					}
				},
				react.createElement("span", {
					style: { width: 6, height: 6, borderRadius: "50%", background: props.color }
				}),
				props.text
			);
		}

		function InfoRow(props) {
			return react.createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 10,
						fontSize: 12,
						lineHeight: "20px"
					}
				},
				react.createElement(
					"span",
					{ style: { color: "var(--dsw-alias-label-tertiary, #999)", flex: "0 0 auto" } },
					props.label
				),
				react.createElement(
					"span",
					{
						style: {
							color: "var(--dsw-alias-label-primary, inherit)",
							fontVariantNumeric: "tabular-nums",
							textAlign: "right",
							minWidth: 0,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap"
						}
					},
					props.value
				)
			);
		}

		function UpdaterCard(props) {
			const t = props.t;
			const [data, setData] = react.useState(null);
			const [showLog, setShowLog] = react.useState(false);
			const mounted = react.useRef(true);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const refresh = react.useCallback(async () => {
				try {
					const resp = await fetch(BASE + "/state", {
						method: "GET",
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					if (resp.ok && mounted.current) setData(await resp.json());
				} catch {
					/* transient: keep last snapshot */
				}
			}, []);

			react.useEffect(() => {
				refresh();
				const timer = setInterval(refresh, POLL_MS);
				return () => clearInterval(timer);
			}, [refresh]);

			const post = async (path, body) => {
				await fetch(BASE + path, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					credentials: "same-origin",
					body: JSON.stringify(body)
				});
				await refresh();
			};

			const running = data?.running === true;
			const statusKey = running ? "running" : data?.lastResult ?? "unknown";
			const statusColor = STATUS_COLOR[statusKey] ?? STATUS_COLOR.unknown;
			const statusText = t("card.status." + statusKey);
			const lastCheck = fmtTime(data?.lastCheckAt);

			const header = react.createElement(
				"div",
				{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 4 } },
				react.createElement("span", { style: { fontSize: 13, fontWeight: 600 } }, t("card.title")),
				react.createElement(Badge, { color: statusColor, text: statusText })
			);

			const hint = react.createElement(
				"div",
				{ style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", marginBottom: 10, lineHeight: "16px" } },
				t("card.hint")
			);

			const versionRows = react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 4 } },
				react.createElement(InfoRow, {
					label: t("card.current"),
					value: data?.currentVersion ?? "—"
				}),
				react.createElement(InfoRow, {
					label: t("card.latest"),
					value: data?.latestVersion ?? "—"
				}),
				react.createElement(InfoRow, {
					label: t("card.lastCheck"),
					value: lastCheck ?? t("card.never")
				})
			);

			const toggleRow = react.createElement(
				"label",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 10,
						fontSize: 12,
						marginTop: 10,
						cursor: "pointer"
					}
				},
				react.createElement(
					"span",
					{ style: { color: "var(--dsw-alias-label-secondary, #666)" } },
					t("card.auto")
				),
				react.createElement("input", {
					type: "checkbox",
					checked: data?.config?.enabled !== false,
					onChange: (e) => post("/config", { enabled: e.target.checked })
				})
			);

			const intervalRow = react.createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 10,
						fontSize: 12,
						marginTop: 8
					}
				},
				react.createElement(
					"span",
					{ style: { color: "var(--dsw-alias-label-secondary, #666)" } },
					t("card.interval")
				),
				react.createElement(
					"span",
					{ style: { display: "inline-flex", alignItems: "center", gap: 6 } },
					react.createElement(
						"select",
						{
							value: data?.config?.intervalHours ?? 24,
							onChange: (e) => post("/config", { intervalHours: Number(e.target.value) }),
							style: {
								font: "inherit",
								fontSize: 12,
								padding: "3px 6px",
								borderRadius: "var(--dsw-radius-xs, 4px)",
								border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
								background: "var(--dsw-alias-bg-layer-1, #fff)",
								color: "var(--dsw-alias-label-primary, inherit)"
							}
						},
						[6, 12, 24, 48].map((h) =>
							react.createElement("option", { key: h, value: h }, String(h))
						)
					),
					react.createElement(
						"span",
						{ style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } },
						t("card.hours")
					)
				)
			);

			const buttons = react.createElement(
				"div",
				{ style: { display: "flex", gap: 8, marginTop: 12 } },
				react.createElement(
					"button",
					{
						type: "button",
						disabled: running,
						onClick: () => post("/check", {}),
						style: {
							flex: "1 1 auto",
							padding: "6px 10px",
							borderRadius: "var(--dsw-radius-sm, 6px)",
							border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
							background: "var(--dsw-alias-bg-layer-1, #fff)",
							color: "var(--dsw-alias-label-primary, inherit)",
							font: "inherit",
							fontSize: 12,
							fontWeight: 600,
							cursor: running ? "default" : "pointer"
						}
					},
					running ? t("card.checking") : t("card.checkNow")
				),
				react.createElement(
					"button",
					{
						type: "button",
						onClick: () => setShowLog((v) => !v),
						style: {
							padding: "6px 12px",
							borderRadius: "var(--dsw-radius-sm, 6px)",
							border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
							background: "transparent",
							color: "var(--dsw-alias-label-secondary, #666)",
							font: "inherit",
							fontSize: 12,
							cursor: "pointer"
						}
					},
					showLog ? t("card.hideLog") : t("card.showLog")
				)
			);

			const logBox = showLog
				? react.createElement(
					"pre",
					{
						style: {
							marginTop: 10,
							maxHeight: 220,
							overflow: "auto",
							padding: "8px 10px",
							borderRadius: "var(--dsw-radius-sm, 6px)",
							background: "var(--dsw-alias-bg-layer-2, #0000000a)",
							border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
							fontFamily: "var(--dsw-font-mono, monospace)",
							fontSize: 10.5,
							lineHeight: "15px",
							whiteSpace: "pre-wrap",
							wordBreak: "break-all",
							color: "var(--dsw-alias-label-secondary, #666)"
						}
					},
					(data?.recentLogs ?? []).join("\n") || "—"
				)
				: null;

			return react.createElement(
				"div",
				{
					style: {
						boxSizing: "border-box",
						padding: "12px 14px",
						border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
						borderRadius: "var(--dsw-radius-md, 12px)",
						background: "var(--dsw-alias-bg-layer-1, #fff)"
					}
				},
				header,
				hint,
				versionRows,
				toggleRow,
				intervalRow,
				buttons,
				logBox
			);
		}

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "workbuddy-updater: copy");
				const t = ctx.locale.bind(NS);
				for (const key of CARD_KEYS) {
					ctx.slots.inject("plugins.bundle.config", () =>
						ctx.slots.register(
							{
								name: "plugins.bundle.config",
								key,
								priority: 30,
								inject: () => ({ t })
							},
							UpdaterCard
						)
					);
					ctx.slots.inject("plugins.row.config", () =>
						ctx.slots.register(
							{
								name: "plugins.row.config",
								key: key === PKG ? key : key,
								priority: 30,
								inject: () => ({ t })
							},
							UpdaterCard
						)
					);
				}
			} catch (error) {
				console.error("[dsh-workbuddy-auto-updater] registration failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = INJECT;
		exports.name = NAME;
		return module.exports;
	}
});
