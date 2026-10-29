"""Render confirmed run-level latency summaries with matplotlib (no request pooling)."""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def read_analysis(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def proxy_cpu_limit(path):
    runtime_path = Path(path).parent / "runtime.json"
    if not runtime_path.exists():
        return "unknown"
    runtime = read_analysis(runtime_path)
    for container in runtime.get("containers", []):
        if container.get("service") == "toxiproxy":
            return f'{container["nanoCpus"] / 1_000_000_000:g}'
    return "unknown"


def plot_groups(axis, groups, metric, title, pool=None):
    selected = sorted(
        (g for g in groups if g["cleanPairs"] and (pool is None or g["poolSize"] == pool)),
        key=lambda g: g["rttMs"],
    )
    for strategy, label, color in (
        ("v1", "v1: single JOIN", "#2166ac"),
        ("v2", "v2: split SELECTs", "#c43c39"),
    ):
        for index, block in enumerate(sorted({g.get("plotBlock", 0) for g in selected})):
            block_groups = [g for g in selected if g.get("plotBlock", 0) == block]
            x = [g["rttMs"] for g in block_groups]
            stats = [g["pairedRunMetrics"][strategy][metric] for g in block_groups]
            y = [s["median"] for s in stats]
            lower = [s["median"] - s["min"] for s in stats]
            upper = [s["max"] - s["median"] for s in stats]
            axis.errorbar(x, y, yerr=[lower, upper], marker="o" if strategy == "v1" else "s",
                          linestyle="-" if strategy == "v1" else "--", capsize=4,
                          linewidth=2, color=color, label=label if index == 0 else None)
    axis.set_title(title, loc="left", fontweight="bold")
    axis.set_xlabel("Configured added DB RTT (ms)")
    axis.set_ylabel("HTTP latency (ms)")
    ordered_ticks = sorted({g["rttMs"] for g in selected})
    counts = {g["rttMs"]: g["cleanPairs"] for g in selected}
    axis.set_xticks(ordered_ticks, [f"{rtt}\n(n={counts[rtt]})" for rtt in ordered_ticks])
    axis.set_ylim(bottom=0)
    axis.grid(axis="y", alpha=0.25)
    axis.spines[["top", "right"]].set_visible(False)
    axis.legend(frameon=False, fontsize=9)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirmation", required=True, nargs="+", help="Confirmation analysis.json file(s)")
    parser.add_argument("--load", required=True, help="Concurrency analysis.json")
    parser.add_argument("--output", required=True, help="Output PNG path; SVG is also written")
    args = parser.parse_args()
    confirmations = [read_analysis(path) for path in args.confirmation]
    load = read_analysis(args.load)
    for analysis in (*confirmations, load):
        if not analysis["coverage"]["campaignComplete"]:
            raise ValueError("Only completed campaigns can be plotted for the final report")
    low_groups = [{**g, "plotBlock": block} for block, confirmation in enumerate(confirmations)
                  for g in confirmation["groups"] if g["stage"] == "refine"
                  and g["route"] == "proxy" and g["model"] == "closed" and g["vus"] == 1]
    load_groups = [g for g in load["groups"] if g["stage"] == "load"
                   and g["route"] == "proxy" and g["model"] == "closed" and g["vus"] == 20]
    if len({g["poolSize"] for g in low_groups}) != 1:
        raise ValueError("Confirmation plot requires one fixed pool size")
    if len({g["rttMs"] for g in low_groups}) != len(low_groups):
        raise ValueError("Duplicate confirmation RTT groups cannot be pooled")
    for groups in (low_groups, load_groups):
        signatures = {g.get("scanSettingsSignature") for g in groups}
        if len(signatures) > 1:
            raise ValueError("Incompatible workload settings cannot share a plot")
        if any(g["cleanPairs"] < 1 for g in groups):
            raise ValueError("Every plotted condition requires at least one matched clean pair")
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11})
    figure, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)
    plot_groups(axes[0, 0], low_groups, "httpP50Ms", "1 VU: p50")
    plot_groups(axes[0, 1], low_groups, "httpP95Ms", "1 VU: p95")
    for axis, pool in zip(axes[1], (2, 10)):
        plot_groups(axis, load_groups, "httpP95Ms", f"20 VUs, pool {pool}: p95", pool)
    figure.suptitle("DB latency changes the query-strategy tradeoff", fontsize=18, fontweight="bold")
    block_note = " Separate confirmation blocks are not joined." if len(confirmations) > 1 else ""
    low_cpu_limits = ", ".join(sorted({proxy_cpu_limit(path) for path in args.confirmation}))
    resource_note = (f"\nProxy CPU limits: low concurrency {low_cpu_limits}; load {proxy_cpu_limit(args.load)} cores. "
                     "n = matched clean run pairs.")
    figure.supxlabel("Run-level medians; whiskers = observed min/max, not confidence intervals.\n"
                       "Matched clean pairs only; configured RTT differs from measured query latency."
                       + block_note + resource_note, fontsize=9)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=180)
    svg_output = output.with_suffix(".svg")
    figure.savefig(svg_output)
    svg_output.write_text("\n".join(line.rstrip() for line in svg_output.read_text(encoding="utf-8").splitlines())
                          + "\n", encoding="utf-8", newline="\n")
    plt.close(figure)
    print(output)


if __name__ == "__main__":
    main()
