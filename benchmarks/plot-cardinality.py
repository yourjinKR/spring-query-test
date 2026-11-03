"""Plot validated returned rows and run-level HTTP latency (matplotlib required)."""

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


STRATEGIES = (
    ("v1", "Single JOIN (v1)", "#2166ac", "o", "-"),
    ("v2", "Split Query (v2)", "#c43c39", "s", "--"),
)


def read_groups(path, stage):
    analysis = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if analysis.get("experiment") != "cardinality":
        raise ValueError(f"{path}: expected a cardinality analysis")
    if not analysis.get("coverage", {}).get("campaignComplete"):
        raise ValueError(f"{path}: final figures require a completed campaign")
    groups = sorted(
        (group for group in analysis["groups"] if group["stage"] == stage),
        key=lambda group: (group["commentsPerPost"], group["attachmentsPerPost"]),
    )
    if not groups or len({group["scenario"] for group in groups}) != len(groups):
        raise ValueError(f"{path}: missing or duplicate {stage} scenarios")
    signatures = {json.dumps(group.get("scanSettings"), sort_keys=True) for group in groups}
    if len(signatures) != 1 or groups[0].get("scanSettings") is None:
        raise ValueError(f"{path}: incompatible workload settings cannot share a plotted curve")
    for group in groups:
        if group["cleanPairs"] < 1:
            raise ValueError(f"{path}: {group['scenario']} has no matched clean pair")
        c, a = group["commentsPerPost"], group["attachmentsPerPost"]
        expected = {"v1": 10 * max(1, c) * max(1, a), "v2": 10 * (1 + c + a)}
        for strategy, *_ in STRATEGIES:
            rows = group["actualRows"][strategy]
            if group["expectedRows"][strategy] != expected[strategy] or any(
                rows.get(name) != expected[strategy] for name in ("min", "median", "max")
            ) or rows.get("n") != group["cleanPairs"]:
                raise ValueError(f"{path}: {group['scenario']} {strategy} rows do not match the formula")
            for metric in ("httpP50Ms", "httpP95Ms"):
                stat = group["pairedRunMetrics"][strategy][metric]
                if stat["n"] != group["cleanPairs"] or any(
                    not isinstance(stat.get(name), (int, float))
                    or not math.isfinite(stat[name]) or stat[name] < 0
                    for name in ("min", "median", "max")
                ) or not stat["min"] <= stat["median"] <= stat["max"]:
                    raise ValueError(f"{path}: invalid {metric} run statistics")
    return groups


def style_axis(axis):
    axis.grid(axis="y", alpha=0.22)
    axis.spines[["top", "right"]].set_visible(False)
    axis.set_ylim(bottom=0)


def save_figure(figure, prefix, kind):
    paths = [Path(f"{prefix}-{kind}.{extension}") for extension in ("png", "svg")]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        figure.savefig(path, dpi=180, facecolor="white")
        if path.suffix == ".svg":
            path.write_text(
                "\n".join(line.rstrip() for line in path.read_text(encoding="utf-8").splitlines()) + "\n",
                encoding="utf-8", newline="\n",
            )
        print(path)
    plt.close(figure)


def plot_rows(groups, prefix):
    figure, axis = plt.subplots(figsize=(12, 6.2))
    figure.subplots_adjust(left=0.09, right=0.98, bottom=0.20, top=0.84)
    positions = list(range(len(groups)))
    for strategy, label, color, marker, line in STRATEGIES:
        values = [group["actualRows"][strategy]["median"] for group in groups]
        axis.plot(positions, values, color=color, marker=marker, linestyle=line, linewidth=2, label=label)
        axis.annotate(f"{values[-1]:,.0f}", (positions[-1], values[-1]), xytext=(-6, 12),
                      textcoords="offset points", ha="right", color=color, fontsize=10)
    axis.set_xticks(positions, [group["scenario"] for group in groups])
    axis.set_xlabel("Comments / attachments per post (10 queried parents)", labelpad=10)
    axis.set_ylabel("Returned flat rows / request")
    style_axis(axis)
    axis.set_ylim(top=max(group["expectedRows"]["v1"] for group in groups) * 1.12)
    axis.ticklabel_format(axis="y", style="plain")
    axis.legend(loc="upper left", frameon=False)
    figure.suptitle("Multiplicative JOIN rows vs. additive split-query rows", fontsize=17, fontweight="bold")
    figure.text(0.5, 0.89, "Fixed IDs 1-10 · body 1,024 bytes · UNIFORM · direct DB · pool 10 · 1 VU",
                ha="center", fontsize=10, color="#526078")
    figure.text(0.5, 0.045,
                "Measured rows equal the cardinality formulas in every plotted clean run.\n"
                "v1 = 10 × max(1, comments) × max(1, attachments); v2 = 10 × (1 + comments + attachments).\n"
                "Returned rows are neither internal scan rows nor measured network bytes.",
                ha="center", fontsize=9, color="#526078")
    save_figure(figure, prefix, "rows")


def plot_latency(blocks, prefix):
    figure, axes = plt.subplots(len(blocks), 2, figsize=(13, 4.2 * len(blocks) + 1.5), squeeze=False)
    figure.subplots_adjust(left=0.07, right=0.98, top=0.83 if len(blocks) == 1 else 0.88,
                           bottom=0.23 if len(blocks) == 1 else 0.19, hspace=0.55, wspace=0.20)
    has_low_cardinality_zoom = False
    for row, (label, groups) in enumerate(blocks):
        duration = groups[0]["scanSettings"]["durationMs"] / 1000
        positions = list(range(len(groups)))
        for column, (metric, percentile) in enumerate((("httpP50Ms", "p50"), ("httpP95Ms", "p95"))):
            axis = axes[row, column]
            for strategy, strategy_label, color, marker, line in STRATEGIES:
                stats = [group["pairedRunMetrics"][strategy][metric] for group in groups]
                centers = [stat["median"] for stat in stats]
                lower = [stat["median"] - stat["min"] for stat in stats]
                upper = [stat["max"] - stat["median"] for stat in stats]
                axis.errorbar(positions, centers, yerr=[lower, upper], capsize=4, linewidth=2,
                              color=color, marker=marker, linestyle=line, label=strategy_label)
            axis.set_title(f"{label}: HTTP {percentile} ({duration:g}s / run)", loc="left", fontweight="bold", fontsize=11)
            axis.set_xticks(positions, [f"{group['scenario']}\n(n={group['cleanPairs']})" for group in groups], fontsize=8)
            axis.set_xlabel("Comments / attachments per post", labelpad=7)
            axis.set_ylabel("HTTP latency (ms)")
            style_axis(axis)
            low_groups = [group for group in groups if group["expectedRows"]["v1"] <= 250]
            if label == "Confirmation" and len(low_groups) >= 2:
                has_low_cardinality_zoom = True
                # Keep the full-range categorical comparison intact. A separate
                # inset scale exposes the low-row differences without joining
                # exploration requests to the confirmation observations.
                zoom = axis.inset_axes([0.075, 0.44, 0.47, 0.45])
                low_positions = list(range(len(low_groups)))
                low_extents = []
                for strategy, _, color, marker, line in STRATEGIES:
                    low_stats = [group["pairedRunMetrics"][strategy][metric] for group in low_groups]
                    low_centers = [stat["median"] for stat in low_stats]
                    zoom.errorbar(low_positions, low_centers,
                                  yerr=[[stat["median"] - stat["min"] for stat in low_stats],
                                        [stat["max"] - stat["median"] for stat in low_stats]],
                                  capsize=2.5, linewidth=1.25, markersize=4,
                                  color=color, marker=marker, linestyle=line)
                    low_extents.extend(value for stat in low_stats for value in (stat["min"], stat["max"]))
                style_axis(zoom)
                low_min, low_max = min(low_extents), max(low_extents)
                padding = max((low_max - low_min) * 0.18, low_max * 0.04, 0.05)
                zoom.set_ylim(max(0, low_min - padding), low_max + padding)
                zoom.set_xticks(low_positions, [group["scenario"] for group in low_groups], fontsize=7)
                zoom.tick_params(axis="y", labelsize=7)
                zoom.set_ylabel("ms (zoom)", fontsize=7, labelpad=3)
                zoom.set_title("JOIN \u2264 250 rows: expanded scale", fontsize=8, loc="left", pad=5)
                for spine in zoom.spines.values():
                    spine.set_visible(True)
                    spine.set_color("#aab3c2")
                    spine.set_linewidth(0.7)
                # The inset occupies the upper left. Headroom reserves the
                # upper right for the main legend above the full-range curve.
                full_max = max(group["pairedRunMetrics"][strategy][metric]["max"]
                               for group in groups for strategy, *_ in STRATEGIES)
                axis.set_ylim(top=max(full_max * 1.20, 0.1))
                axis.legend(loc="upper right", frameon=False, fontsize=8)
            else:
                axis.legend(frameon=False, fontsize=9)
    figure.suptitle("Query-strategy latency as child cardinality grows", fontsize=17, fontweight="bold")
    figure.text(0.5, 0.91 if len(blocks) == 1 else 0.93,
                "Fixed IDs 1-10 · body 1,024 bytes · UNIFORM · direct DB · pool 10 · 1 VU",
                ha="center", fontsize=10, color="#526078")
    zoom_note = ("\nConfirmation insets magnify JOIN \u2264 250-row scenarios; inset y-axis scales differ from the main panels."
                 if has_low_cardinality_zoom else "")
    figure.text(0.5, 0.035,
                "Matched clean run pairs only; n = independent run pairs. Centers = median of run statistics.\n"
                "Whiskers = observed run min/max, not confidence intervals. Request percentiles are not pooled.\n"
                "Exploration and confirmation remain separate; categorical spacing does not imply equal row-count increments."
                + zoom_note,
                ha="center", fontsize=9, color="#526078")
    save_figure(figure, prefix, "latency")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sweep", required=True, help="Completed exploration analysis.json")
    parser.add_argument("--confirmation", help="Completed confirmation analysis.json (optional)")
    parser.add_argument("--output", required=True, help="Output path prefix, without an extension")
    args = parser.parse_args()
    sweep = read_groups(args.sweep, "sweep")
    blocks = [("Exploration", sweep)]
    if args.confirmation:
        blocks.append(("Confirmation", read_groups(args.confirmation, "confirm")))
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10})
    prefix = Path(args.output).resolve()
    input_paths = {Path(path).resolve() for path in (args.sweep, args.confirmation) if path}
    output_paths = {Path(f"{prefix}-{kind}.{extension}") for kind in ("rows", "latency") for extension in ("png", "svg")}
    if input_paths & output_paths:
        raise ValueError("Figures must not overwrite analysis inputs")
    plot_rows(sweep, prefix)
    plot_latency(blocks, prefix)


if __name__ == "__main__":
    main()
