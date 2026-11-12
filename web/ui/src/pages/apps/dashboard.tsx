// Original dashboard presentation and loading states; supplied display data, no app or cloud clients.
import type {CSSProperties} from "react";
import {CircleAlert, Loader2, BarChart3, Folder, RefreshCw, TriangleAlert} from "lucide-react";
import {useI18n, type TranslationFn} from "../presentation/i18n";
import {GradeBadge, DashboardTextList, cleanDashboardAlert, dashboardGradeShortLabel, type DashboardGrade} from "./dashboard-primitives";
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export interface DashboardView {items: DashboardItem[]}
export interface DashboardMetric {
  label: string;
  grade: DashboardGrade;
}

export interface DashboardFunnelDataChapter {
  chapter: number;
  label: string;
  uv?: number;
  reachPercent?: number;
  paid?: boolean;
  grade: DashboardGrade;
}

export interface DashboardFunnelData {
  freeChapters?: number;
  totalChapters?: number;
  mode?: "split" | "dropoff";
  maxDropChapter?: {
    from?: number;
    to?: number;
    label?: string;
  };
  chapters?: DashboardFunnelDataChapter[];
}

export interface DashboardCommission {
  label?: string;
  estimate: string;
  parts?: Array<{
    label: string;
    estimate: string;
  }>;
  state: "pending" | "paid";
  source: "local_mock" | "cloud";
  mock?: boolean;
}

export interface DashboardItem {
  id: string;
  title: string;
  grade: DashboardGrade;
  topAlert?: string;
  submittedAt?: string;
  dataAvailable?: boolean;
  preview?: boolean;
  dataGrade?: DashboardGrade;
  dataTopAlert?: string;
  review?: {
    grade: DashboardGrade;
    topAlert?: string;
    sections: {
      diagnosis?: {
        strengths?: string[];
        suggestions?: string[];
      };
    };
  };
  commission?: DashboardCommission;
  sections: {
    acquisition?: {
      metrics?: DashboardMetric[];
    };
    retention?: {
      metrics?: DashboardMetric[];
      funnel?: DashboardFunnelData;
    };
    revenue?: {
      metrics?: DashboardMetric[];
    };
    diagnosis?: {
      strengths?: string[];
      suggestions?: string[];
    };
  };
}

function MountedAppDirectoryLoadingState(props: { label: string }) {
  return (
    <div className="og-skeleton-stack" role="status" aria-label={props.label} aria-busy="true">
      <span className="og-skeleton og-skeleton-line" style={{ width: "68%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "84%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "58%" }} />
      <span className="og-skeleton og-skeleton-line" style={{ width: "76%" }} />
    </div>
  );
}

function MountedAppPreviewLoadingState(props: { label: string }) {
  return (
    <div className="mounted-app-preview-empty" role="status" aria-label={props.label} aria-busy="true">
      <div className="og-skeleton-stack">
        <span className="og-skeleton og-skeleton-line" style={{ width: "34%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "72%" }} />
        <span className="og-skeleton og-skeleton-line" style={{ width: "61%" }} />
      </div>
    </div>
  );
}

export function DashboardList(props: {
  dashboard: DashboardView | undefined;
  loading: boolean;
  error: string;
  refreshing: boolean;
  selectedItemId: string;
  onRefresh(): void;
  onSelect(itemId: string): void;
}) {
  const { t } = useI18n();
  if (props.loading && !props.dashboard) {
    return <MountedAppDirectoryLoadingState label={t("mountedApp.dashboardLoading")} />;
  }
  if (props.error && !props.dashboard) {
    return (
      <div className="mounted-app-tree-state">
        <CircleAlert size={15} />
        <span>{dashboardErrorLabel(props.error)}</span>
        <button
          className="mounted-app-dashboard-retry"
          type="button"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          {props.refreshing ? (
            <Loader2 className="mounted-app-dashboard-refresh-icon" data-spinning="true" size={14} />
          ) : null}
          {t("mountedApp.retry")}
        </button>
      </div>
    );
  }
  const items = props.dashboard?.items ?? [];
  if (!items.length) {
    return (
      <div className="mounted-app-tree-state">
        <BarChart3 size={15} />
        <span>{t("mountedApp.dashboardEmpty")}</span>
      </div>
    );
  }
  return (
    <div className="mounted-app-dashboard-list">
      <DashboardErrorNotice error={props.error} refreshing={props.refreshing} onRefresh={props.onRefresh} />
      <section className="mounted-app-dashboard-items" aria-label={t("mountedApp.dashboardBooks")}>
        {items.map((item) => (
          <button
            className="mounted-app-dashboard-row"
            type="button"
            data-active={item.id === props.selectedItemId ? "true" : "false"}
            key={item.id}
            onClick={() => props.onSelect(item.id)}
          >
            <Folder size={14} />
            <span>
              <strong title={item.title}>{item.title}</strong>
            </span>
          </button>
        ))}
      </section>
    </div>
  );
}

export function DashboardPreview(props: {
  item: DashboardItem | undefined;
  loading: boolean;
  error: string;
  refreshing: boolean;
  source?: "cloud" | "local_mock";
  onRefresh(): void;
}) {
  const { t } = useI18n();
  if (props.loading && !props.item) {
    return <MountedAppPreviewLoadingState label={t("mountedApp.dashboardLoading")} />;
  }
  if (props.error && !props.item) {
    return (
      <div className="mounted-app-preview-empty">
        <CircleAlert size={18} />
        <strong>{dashboardErrorLabel(props.error)}</strong>
        <button
          className="mounted-app-dashboard-retry"
          type="button"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          {props.refreshing ? (
            <Loader2 className="mounted-app-dashboard-refresh-icon" data-spinning="true" size={14} />
          ) : null}
          {t("mountedApp.retry")}
        </button>
      </div>
    );
  }
  if (!props.item) {
    return (
      <div className="mounted-app-preview-empty">
        <BarChart3 size={18} />
        <strong>{t("mountedApp.dashboardSelectBook")}</strong>
      </div>
    );
  }
  // 飞书式呈现：把同一份档位数据重排成「大数字 hero + 可视化进度叙事 + 分组卡片」。
  // 留存与吸引力两组指标合并进一个进度条矩阵，漏斗从纯文字升级为分段可视化条。
  const item = props.item;
  const retentionMetrics = item.sections.retention?.metrics ?? [];
  const acquisitionMetrics = item.sections.acquisition?.metrics ?? [];
  const funnel = item.sections.retention?.funnel;
  const suggestions = item.sections.diagnosis?.suggestions ?? [];
  const strengths = item.sections.diagnosis?.strengths ?? [];
  return (
    <div className="mounted-app-dashboard-preview">
      <header className="mounted-app-dashboard-preview-header">
        <h2>{item.title}</h2>
        <button
          type="button"
          disabled={props.refreshing}
          onClick={props.onRefresh}
          title={t("mountedApp.refresh")}
          aria-label={t("mountedApp.refresh")}
        >
          <RefreshCw
            className="mounted-app-dashboard-refresh-icon"
            data-spinning={props.refreshing ? "true" : "false"}
            size={15}
          />
        </button>
      </header>
      <div className="mounted-app-dashboard-preview-scroll">
        <DashboardErrorNotice error={props.error} refreshing={props.refreshing} onRefresh={props.onRefresh} />
        <DashboardHero grade={item.grade} topAlert={item.topAlert} commission={item.commission} />
        {retentionMetrics.length || acquisitionMetrics.length ? (
          <section className="mounted-app-dashboard-card">
            {retentionMetrics.length ? (
              <DashboardMetricGroup title={t("mountedApp.dashboardRetention")} metrics={retentionMetrics} />
            ) : null}
            {acquisitionMetrics.length ? (
              <DashboardMetricGroup title={t("mountedApp.dashboardAcquisitionFallback")} metrics={acquisitionMetrics} />
            ) : null}
          </section>
        ) : null}
        <DashboardFunnel funnel={funnel} />
        {suggestions.length || strengths.length ? (
          <section className="mounted-app-dashboard-card mounted-app-dashboard-diagnosis">
            <h3>{t("mountedApp.dashboardDiagnosis")}</h3>
            <div className="mounted-app-dashboard-diagnosis-grid">
              <DashboardTextList tone="suggestion" title={t("mountedApp.dashboardSuggestions")} items={suggestions} />
              <DashboardTextList tone="strength" title={t("mountedApp.dashboardStrengths")} items={strengths} />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// ===== Shared dashboard presentation =====

export function DashboardErrorNotice(props: { error: string; refreshing: boolean; onRefresh(): void }) {
  const { t } = useI18n();
  if (!props.error) return null;
  return (
    <div className="mounted-app-dashboard-error-notice" role="status">
      <CircleAlert size={15} />
      <span>{dashboardErrorLabel(props.error)}</span>
      <button
        className="mounted-app-dashboard-retry"
        type="button"
        disabled={props.refreshing}
        onClick={props.onRefresh}
      >
        {props.refreshing ? (
          <Loader2 className="mounted-app-dashboard-refresh-icon" data-spinning="true" size={14} />
        ) : null}
        {t("mountedApp.retry")}
      </button>
    </div>
  );
}

function dashboardErrorLabel(error: string): string {
  return error;
}

// Hero：飞书式焦点区——整体档徽章 + 顶部警示行 + 可选业务指标。
export function DashboardHero(props: {
  grade: DashboardGrade;
  topAlert?: string;
  commission?: DashboardItem["commission"];
}) {
  const { t } = useI18n();
  const commissionParts = props.commission?.parts?.length
    ? props.commission.parts
    : props.commission?.estimate
      ? [{ label: props.commission.label || t("mountedApp.dashboardCommission"), estimate: props.commission.estimate }]
      : [];
  return (
    <section className="mounted-app-dashboard-card mounted-app-dashboard-hero">
      <div className="mounted-app-dashboard-hero-top">
        <span className="mounted-app-dashboard-hero-kicker">{t("mountedApp.dashboardOverallGrade")}</span>
        <GradeBadge grade={props.grade} />
      </div>
      {props.topAlert ? (
        <p className="mounted-app-dashboard-alert" data-grade={props.grade}>
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{cleanDashboardAlert(props.topAlert)}</span>
        </p>
      ) : null}
      {commissionParts.length ? (
        <div className="mounted-app-dashboard-hero-stats">
          {commissionParts.map((part) => (
            <div className="mounted-app-dashboard-stat" key={`${part.label}-${part.estimate}`}>
              <span>{part.label}</span>
              <strong>{part.estimate}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// 进度条矩阵：每个指标一行——标签 + 档位驱动的彩色进度条 + 档位文字。
export function DashboardMetricGroup(props: {
  title: string;
  metrics: Array<{ label: string; grade: DashboardGrade }>;
}) {
  return (
    <div className="mounted-app-dashboard-metric-group">
      <span className="mounted-app-dashboard-card-label">{props.title}</span>
      <div className="mounted-app-dashboard-metric-rows">
        {props.metrics.map((metric) => (
          <MetricRow key={metric.label} label={metric.label} grade={metric.grade} />
        ))}
      </div>
    </div>
  );
}

// 指标行：色条长度+颜色把档位变成视觉量，横排对齐一眼可比。
export function MetricRow(props: { label: string; grade: DashboardGrade }) {
  const { t } = useI18n();
  return (
    <div className="mounted-app-dashboard-metric" data-grade={props.grade}>
      <span className="mounted-app-dashboard-metric-label">{props.label}</span>
      <div className="mounted-app-dashboard-metric-bar" aria-hidden="true">
        <i />
      </div>
      <small className="mounted-app-dashboard-metric-grade">{dashboardGradeShortLabel(props.grade, t)}</small>
    </div>
  );
}

// 漏斗卡：有章节到达数据时渲染「章节留存带」——每章一根柱、高度=到达率，
// 免费/付费分界画竖虚线，最大流失章标红，结论放卡头；没有到达数据时退回
// 「免费章 / 付费章」比例条，避免渲染整页空行。
export function DashboardFunnel(props: { funnel: DashboardFunnelData | undefined }) {
  const { t } = useI18n();
  const funnel = props.funnel;
  const chapters = (funnel?.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.chapter) && chapter.chapter > 0)
    .sort((left, right) => left.chapter - right.chapter);
  const mode = funnel?.mode === "dropoff" ? "dropoff" : "split";
  const inferredTotal = chapters.reduce((largest, chapter) => Math.max(largest, chapter.chapter), 0);
  const inferredFree = inferDashboardFunnelFree(chapters);
  const free = typeof funnel?.freeChapters === "number" && funnel.freeChapters > 0 ? funnel.freeChapters : inferredFree;
  const total =
    typeof funnel?.totalChapters === "number" && funnel.totalChapters > 0 ? funnel.totalChapters : inferredTotal;
  if (total <= 0 && !chapters.length) return null;
  const drop = funnel?.maxDropChapter;
  const maxDrop =
    drop?.label ||
    (drop?.from && drop?.to
      ? t("mountedApp.dashboardFunnelDrop", { from: String(drop.from), to: String(drop.to) })
      : "");
  const dropSummary = [maxDrop, dashboardFunnelDropDelta(chapters, drop)].filter(Boolean).join(" · ");
  const hasReachData = chapters.some((chapter) => normalizedDashboardPercent(chapter.reachPercent) !== undefined);
  const boundaryRatio =
    total > 0 ? (mode === "dropoff" && drop?.from ? clamp(drop.from / total, 0, 1) : clamp(free / total, 0, 1)) : 0;
  // 断点落在「免费章→付费章」边界附近，用 from 章节在总量中的相对位置标记。
  const dropAt = drop?.from && total > 0 ? clamp(drop.from / total, 0, 1) : null;
  return (
    <section className="mounted-app-dashboard-card mounted-app-dashboard-funnel">
      <div className="mounted-app-dashboard-funnel-head">
        <span className="mounted-app-dashboard-card-label">{t("mountedApp.dashboardFunnel")}</span>
        {dropSummary ? <span className="mounted-app-dashboard-funnel-drop-summary">{dropSummary}</span> : null}
      </div>
      {hasReachData ? (
        <DashboardChapterBand chapters={chapters} free={free} dropTo={drop?.to} />
      ) : total > 0 ? (
        <>
          <div
            className="mounted-app-dashboard-funnel-bar"
            data-mode={mode}
            style={{ "--funnel-free": `${Math.round(boundaryRatio * 100)}%` } as CSSProperties}
            aria-hidden="true"
          >
            <span className="mounted-app-dashboard-funnel-free" />
            <span className="mounted-app-dashboard-funnel-paid" />
            {dropAt !== null ? (
              <span
                className="mounted-app-dashboard-funnel-marker"
                style={{ left: `${Math.round(dropAt * 100)}%` }}
                title={dropSummary || undefined}
              />
            ) : null}
          </div>
          {chapters.length ? (
            <p className="mounted-app-dashboard-funnel-nodata">{t("mountedApp.dashboardFunnelNoData")}</p>
          ) : null}
        </>
      ) : null}
      {mode === "split" ? (
        <div className="mounted-app-dashboard-funnel-legend">
          <span className="mounted-app-dashboard-funnel-legend-free">
            {t("mountedApp.dashboardFunnelFree")} · {free || "-"}
          </span>
          <span className="mounted-app-dashboard-funnel-legend-paid">
            {t("mountedApp.dashboardFunnelPaid")} · {total > free ? total - free : "-"}
          </span>
          <span className="mounted-app-dashboard-funnel-legend-total">
            {t("mountedApp.dashboardFunnelShape", { free: String(free || "-"), total: String(total || "-") })}
          </span>
        </div>
      ) : null}
    </section>
  );
}

// 一根柱 = 一章（章数多时一根柱聚合相邻几章），tooltip 承载章名/到达率/UV/免费付费。
const DASHBOARD_BAND_MAX_BARS = 60;

type DashboardBandBar = {
  key: string;
  title: string;
  reach: number | undefined;
  phase: "free" | "paid" | "mixed";
  drop: boolean;
};

// 章节留存带：X 轴按章节顺序排布，柱高=到达率，整条带即留存衰减曲线。
export function DashboardChapterBand(props: { chapters: DashboardFunnelDataChapter[]; free: number; dropTo?: number }) {
  const { t } = useI18n();
  const bars = buildDashboardBandBars(props.chapters, props.dropTo, t);
  const freeCount = props.chapters.filter((chapter) => chapter.chapter <= props.free).length;
  const boundaryRatio =
    props.free > 0 && freeCount > 0 && freeCount < props.chapters.length ? freeCount / props.chapters.length : null;
  const firstChapter = props.chapters[0];
  const lastChapter = props.chapters[props.chapters.length - 1];
  if (!firstChapter || !lastChapter) return null;
  return (
    <div className="mounted-app-dashboard-chapter-band" aria-label={t("mountedApp.dashboardChapterFunnel")}>
      <div className="mounted-app-dashboard-chapter-band-plot">
        {bars.map((bar) => (
          <span
            key={bar.key}
            className="mounted-app-dashboard-chapter-band-bar"
            data-phase={bar.phase}
            data-drop={bar.drop ? "true" : "false"}
            title={bar.title}
          >
            <i
              data-empty={bar.reach === undefined ? "true" : "false"}
              style={bar.reach === undefined ? undefined : { height: `${Math.max(4, Math.round(bar.reach))}%` }}
            />
          </span>
        ))}
        {boundaryRatio !== null ? (
          <span
            className="mounted-app-dashboard-chapter-band-boundary"
            style={{ left: `${(boundaryRatio * 100).toFixed(2)}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="mounted-app-dashboard-chapter-band-axis" aria-hidden="true">
        <span>{firstChapter.label || String(firstChapter.chapter)}</span>
        <small>{t("mountedApp.dashboardFunnelReach")}</small>
        <span>{lastChapter.label || String(lastChapter.chapter)}</span>
      </div>
    </div>
  );
}

function buildDashboardBandBars(
  chapters: DashboardFunnelDataChapter[],
  dropTo: number | undefined,
  t: TranslationFn,
): DashboardBandBar[] {
  const bucketSize = Math.max(1, Math.ceil(chapters.length / DASHBOARD_BAND_MAX_BARS));
  const bars: DashboardBandBar[] = [];
  for (let start = 0; start < chapters.length; start += bucketSize) {
    const bucket = chapters.slice(start, start + bucketSize);
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const reaches = bucket
      .map((chapter) => normalizedDashboardPercent(chapter.reachPercent))
      .filter((value): value is number => value !== undefined);
    const reach = reaches.length ? reaches.reduce((sum, value) => sum + value, 0) / reaches.length : undefined;
    const label =
      bucket.length > 1
        ? t("mountedApp.dashboardFunnelBucket", { from: String(first.chapter), to: String(last.chapter) })
        : first.label || String(first.chapter);
    const phase = bucket.every((chapter) => chapter.paid === true)
      ? ("paid" as const)
      : bucket.every((chapter) => chapter.paid === false)
        ? ("free" as const)
        : ("mixed" as const);
    const reachLabel = formatDashboardPercent(reach);
    // UV 只在单章柱上展示；聚合桶里各章 UV 相加没有业务含义。
    const uvLabel =
      bucket.length === 1 && typeof first.uv === "number" && Number.isFinite(first.uv)
        ? `${formatDashboardInteger(first.uv)} ${t("mountedApp.dashboardFunnelUv")}`
        : "";
    const phaseLabel =
      phase === "paid"
        ? t("mountedApp.dashboardFunnelPaid")
        : phase === "free"
          ? t("mountedApp.dashboardFunnelFree")
          : "";
    bars.push({
      key: `${first.chapter}-${last.chapter}`,
      title: [
        label,
        reachLabel !== "-" ? `${t("mountedApp.dashboardFunnelReach")} ${reachLabel}` : "",
        uvLabel,
        phaseLabel,
      ]
        .filter(Boolean)
        .join(" · "),
      reach,
      phase,
      drop: dropTo !== undefined && bucket.some((chapter) => chapter.chapter === dropTo),
    });
  }
  return bars;
}

// 最大流失点的实际落差（到达率百分点差），两端都有数据时补进卡头摘要。
function dashboardFunnelDropDelta(
  chapters: DashboardFunnelDataChapter[],
  drop: DashboardFunnelData["maxDropChapter"],
): string {
  if (!drop?.from || !drop?.to) return "";
  const fromReach = normalizedDashboardPercent(chapters.find((chapter) => chapter.chapter === drop.from)?.reachPercent);
  const toReach = normalizedDashboardPercent(chapters.find((chapter) => chapter.chapter === drop.to)?.reachPercent);
  if (fromReach === undefined || toReach === undefined) return "";
  const delta = fromReach - toReach;
  if (delta <= 0) return "";
  return `-${formatDashboardPercent(delta)}`;
}

function inferDashboardFunnelFree(chapters: DashboardFunnelDataChapter[]): number {
  const paidStart = chapters
    .filter((chapter) => chapter.paid === true)
    .reduce(
      (first, chapter) => (first === undefined ? chapter.chapter : Math.min(first, chapter.chapter)),
      undefined as number | undefined,
    );
  if (paidStart && paidStart > 1) return paidStart - 1;
  return chapters
    .filter((chapter) => chapter.paid === false)
    .reduce((last, chapter) => Math.max(last, chapter.chapter), 0);
}

function normalizedDashboardPercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clamp(value, 0, 100);
}

function formatDashboardPercent(value: number | undefined): string {
  if (value === undefined) return "-";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`;
}

function formatDashboardInteger(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}

// 作者视角：获客只保留 CTR/CVR（题材吸引力 + 开头留人），去掉作者改不了的 CPA/ARPU。
// 同时把投放行话翻译成作者能懂、能动手的措辞。
