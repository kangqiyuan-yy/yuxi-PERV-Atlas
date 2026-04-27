"""Thin wrapper around pyGenomeTracks that monkey-patches BedTrack.

Two extra INI properties are added:

    color_arrow    – colour of intron arrow markers / backbone  (default: blue)
    color_backbone – colour of the backbone line                (default: black)
    arrow_scale    – multiplier on the built-in arrow tip size  (default: 1.0)
    bar_height_fraction – vertical thickness of gene/transcript ribbons as a
                     fraction of the row height (default: 1.0; use 0.5 for half).

After patching, control is passed to ``pygenometracks.plotTracks.main`` with
the original sys.argv so all other behaviour is identical.
"""

from __future__ import annotations

import sys

import numpy as np
from matplotlib.patches import Polygon


def _bar_dims(self, ypos):
    """Return (y_base, bar_height) honouring optional ``bar_height_fraction``."""
    full_h = float(self.properties['interval_height'])
    frac = float(self.properties.get('bar_height_fraction', 1.0) or 1.0)
    frac = max(0.1, min(1.0, frac))
    bar_h = full_h * frac
    y_base = ypos + (full_h - bar_h) / 2.0
    return y_base, bar_h


def _patched_draw_gene_simple(self, ax, bed, ypos, rgb, edgecolor, linewidth):
    """draw_gene_simple with optional ``bar_height_fraction`` for thinner ribbons."""
    from matplotlib.patches import Polygon, Rectangle

    y_base, bar_h = _bar_dims(self, ypos)
    if bed.strand not in ['+', '-']:
        ax.add_patch(Rectangle((bed.start, y_base), bed.end - bed.start, bar_h,
                               edgecolor=edgecolor, facecolor=rgb, linewidth=linewidth))
        return

    orig_h = self.properties['interval_height']
    self.properties['interval_height'] = bar_h
    try:
        vertices = self._draw_arrow(bed.start, bed.end, bed.strand, y_base)
    finally:
        self.properties['interval_height'] = orig_h
    ax.add_patch(Polygon(vertices, closed=True, fill=True,
                         edgecolor=edgecolor, facecolor=rgb, linewidth=linewidth))


def _patched_draw_arrow(self, start, end, strand, ypos):
    """_draw_arrow with configurable tip size via ``arrow_scale`` property.

    The arrow tip is kept WITHIN [start, end] so that pyGenomeTracks' own
    label (drawn at bed.end + small_relative) is never covered by the tip.
    """
    half_height = float(self.properties['interval_height']) / 2
    scale = float(self.properties.get('arrow_scale', 1.0) or 1.0)
    # Clamp tip to at most half the gene width so tiny genes still look ok.
    tip = min(self.small_relative * scale, (end - start) * 0.5)

    if strand == '+':
        x0, x1 = start, end
        y0, y1 = ypos, ypos + self.properties['interval_height']
        # Body: x0 → (x1-tip);  triangle tip: (x1-tip) → x1  (stays inside bar)
        x_tip = x1 - tip
        vertices = [
            (x0, y0), (x0, y1),
            (x_tip, y1),
            (x1, y0 + half_height),
            (x_tip, y0),
        ]
    else:
        x0, x1 = start, end
        y0, y1 = ypos, ypos + self.properties['interval_height']
        # Triangle tip: x0 → (x0+tip);  body: (x0+tip) → x1  (stays inside bar)
        x_tip = x0 + tip
        vertices = [
            (x0, y0 + half_height),
            (x_tip, y1),
            (x1, y1), (x1, y0),
            (x_tip, y0),
        ]
    return vertices


def _patched_draw_gene_with_introns(self, ax, bed, ypos, rgb, edgecolor, linewidth):
    """draw_gene_with_introns with ``color_arrow`` / ``color_backbone`` and optional bar scaling."""
    if (bed.block_count == 0
            and bed.thick_start == bed.start
            and bed.thick_end == bed.end):
        self.draw_gene_simple(ax, bed, ypos, rgb, edgecolor, linewidth)
        return

    y_base, bar_h = _bar_dims(self, ypos)
    orig_h = self.properties['interval_height']
    self.properties['interval_height'] = bar_h
    try:
        half_height = bar_h / 2
        quarter_height = bar_h / 4
        three_quarter_height = quarter_height * 3

        backbone_color = self.properties.get('color_backbone', 'black') or 'black'
        arrow_color = self.properties.get('color_arrow', 'blue') or 'blue'

        ax.plot(
            [bed.start, bed.end],
            [y_base + half_height, y_base + half_height],
            color=backbone_color, linewidth=linewidth, zorder=-1,
        )

        for idx in range(0, bed.block_count):
            x0 = bed.start + bed.block_starts[idx]
            x1 = x0 + bed.block_sizes[idx]
            if x1 < bed.thick_start or x0 > bed.thick_end:
                y0 = y_base + quarter_height
                y1 = y_base + three_quarter_height
            else:
                y0 = y_base
                y1 = y_base + bar_h

            if x0 < bed.thick_start < x1:
                vertices = ([(x0, y_base + quarter_height), (x0, y_base + three_quarter_height),
                             (bed.thick_start, y_base + three_quarter_height),
                             (bed.thick_start, y_base + bar_h),
                             (bed.thick_start, y_base + bar_h),
                             (x1, y_base + bar_h), (x1, y_base),
                             (bed.thick_start, y_base), (bed.thick_start, y_base + quarter_height)])
            elif x0 < bed.thick_end < x1:
                vertices = ([(x0, y_base),
                             (x0, y_base + bar_h),
                             (bed.thick_end, y_base + bar_h),
                             (bed.thick_end, y_base + three_quarter_height),
                             (x1, y_base + three_quarter_height),
                             (x1, y_base + quarter_height),
                             (bed.thick_end, y_base + quarter_height),
                             (bed.thick_end, y_base)])
            else:
                vertices = ([(x0, y0), (x0, y1), (x1, y1), (x1, y0)])

            ax.add_patch(Polygon(vertices, closed=True, fill=True,
                                 linewidth=linewidth,
                                 edgecolor='none',
                                 facecolor=rgb))

            if idx < bed.block_count - 1:
                intron_length = (bed.block_starts[idx + 1]
                                 - (bed.block_starts[idx] + bed.block_sizes[idx]))
                marker = 5 if bed.strand == '+' else 4
                if intron_length > 3 * self.small_relative:
                    pos = np.arange(
                        x1 + 1 * self.small_relative,
                        x1 + intron_length + self.small_relative,
                        int(2 * self.small_relative),
                    )
                    ax.plot(pos, np.zeros(len(pos)) + y_base + half_height, '.',
                            marker=marker, fillstyle='none',
                            color=arrow_color, markersize=3)
                elif intron_length > self.small_relative:
                    intron_center = x1 + int(intron_length) / 2
                    ax.plot([intron_center], [y_base + half_height], '.',
                            marker=5, fillstyle='none',
                            color=arrow_color, markersize=3)
    finally:
        self.properties['interval_height'] = orig_h


def install_patches() -> None:
    from pygenometracks.tracks import BedTrack as _BedTrackClass
    _BedTrackClass._draw_arrow = _patched_draw_arrow
    _BedTrackClass.draw_gene_simple = _patched_draw_gene_simple
    _BedTrackClass.draw_gene_with_introns = _patched_draw_gene_with_introns


def main() -> int:
    install_patches()
    from pygenometracks.plotTracks import main as pygt_main
    return pygt_main() or 0


if __name__ == "__main__":
    sys.exit(main())
