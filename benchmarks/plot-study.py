"""Plot per-run distributions from analyze-study.mjs CSV (matplotlib required)."""

import argparse
import csv
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="analysis-runs.csv")
    parser.add_argument("output", type=Path, help="PNG output path")
    args = parser.parse_args()

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    from statistics import median

    with args.input.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    clean = [row for row in rows if row["clean"].lower() == "true"]
    # Compare the same repeat pairs: a failed strategy also excludes its partner
    # from the normal latency chart, while both attempts stay in the CSV/report.
    def pair_key(row):
        return (row["poolSize"], row["condition"], row["model"],
                row["vus"], row["rate"], row["repeat"])

    clean_strategies = {}
    for row in clean:
        clean_strategies.setdefault(pair_key(row), set()).add(row["strategy"])
    clean = [row for row in clean
             if clean_strategies[pair_key(row)] == {"v1", "v2"}]
    pools = sorted({int(row["poolSize"]) for row in rows})
    rates = sorted({int(float(row["rate"])) for row in rows if row["rate"]})
    rate = rates[0] if rates else None
    colors = {"v1": "#6366f1", "v2": "#059669"}
    markers = {"v1": "o", "v2": "D"}
    metrics = [("completedRps", "Completed requests / second"),
               ("httpP95Ms", "HTTP p95 (ms)"),
               ("acquireMeanMs", "Mean connection acquisition (ms)")]
    fig, axes = plt.subplots(2, 3, figsize=(14, 9))
    fig.subplots_adjust(left=0.06, right=0.98, top=0.85, bottom=0.16,
                        hspace=0.48, wspace=0.27)

    for row_index, model in enumerate(["closed", "arrival"]):
        selected = [row for row in clean if row["model"] == model
                    and (row["vus"] == "20" if model == "closed" else float(row["rate"]) == rate)]
        label = "Closed model: 20 VUs" if model == "closed" else f"Arrival model: {rate} requests/s"
        for column, (metric, title) in enumerate(metrics):
            ax = axes[row_index, column]
            maximum = 0.0
            for pool_index, pool in enumerate(pools):
                for strategy_index, strategy in enumerate(["v1", "v2"]):
                    group = [row for row in selected if int(row["poolSize"]) == pool and row["strategy"] == strategy and row[metric]]
                    values = [float(row[metric]) for row in group]
                    if not values:
                        continue
                    position = pool_index + (-0.15 if strategy_index == 0 else 0.15)
                    center = median(values)
                    lower, upper = min(values), max(values)
                    maximum = max(maximum, upper)
                    ax.errorbar(position, center, yerr=[[center - lower], [upper - center]],
                                color=colors[strategy], capsize=5, linewidth=2, fmt="_")
                    for index, value in enumerate(values):
                        jitter = (index - (len(values) - 1) / 2) * 0.025
                        ax.scatter(position + jitter, value, marker=markers[strategy],
                                   color=colors[strategy], s=32, alpha=0.8, zorder=3)
                    ax.annotate(f"n={len(values)}", (position, upper), xytext=(0, 7),
                                textcoords="offset points", ha="center", fontsize=8,
                                color=colors[strategy])
            ax.set_title(f"{label}\n{title}", fontsize=11)
            ax.set_xticks(range(len(pools)), [f"Pool {pool}" for pool in pools])
            ax.set_ylim(0, maximum * 1.25 if maximum else 1)
            ax.grid(axis="y", alpha=0.25)
            ax.spines[["top", "right"]].set_visible(False)

    fig.suptitle("Query Lab: repeated v1 / v2 measurements", fontsize=17, y=0.98)
    handles = [Line2D([0], [0], marker=markers[name], color=colors[name], linestyle="none",
                      label=f"{name}: {'one JOIN' if name == 'v1' else 'three bulk SELECTs'}")
               for name in ["v1", "v2"]]
    fig.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, 0.945),
               ncol=2, frameon=False)
    fig.text(0.5, 0.045,
             "Dots: runs from common clean pairs; center: median; whiskers: observed min-max (not confidence intervals).\n"
             "Failed or incomplete loads and their partners remain in the report and are excluded from these comparisons.",
             fontsize=9, ha="center", va="center")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output, dpi=170, facecolor="white")
    fig.savefig(args.output.with_suffix(".pdf"), facecolor="white")
    plt.close(fig)


if __name__ == "__main__":
    main()
