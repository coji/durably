# Design Tokens

対象はファクトリーの web UI（`examples/local-agent-loop`）。brief の原則「色は状態を表すためだけに使う」に従い、ブランドのアクセントは持たない。実装は `src/ui/app.css` にあり、Tailwind v4 の `@theme inline` で意味別の名前のユーティリティ（`bg-raised`、`text-fg-2`、`bg-waiting-bg` など）にしている。部品と画面は色、文字の大きさ、余白を直書きせず、このトークンだけを使う。部品の見本は `#/design` で、ライトとダークを並べて確かめられる。

## Colors

- 中立色：わずかに寒色寄りのグレー（OKLCH、hue 250、chroma 0.004〜0.008）。
- 状態は4種類。色が付くのは3つだけで、待機（人待ち）＝琥珀、失敗＝赤、実行中＝青。4つ目の完了は中立のグレーで、順番待ちや取り消しのように注意の要らない状態もこれを使う。
- 意味別のトークンは、ライトとダークの値を `light-dark()` で1つに持つ。ルートは `color-scheme: light dark` で OS の設定に従い、`color-scheme` を指定した箱（見本のライト・ダークの枠）はその配色になる。
- ダークでは真っ黒は使わず、状態色は彩度を約1割落とす。

## Typography

- 本文：システムフォント、14px。Web フォントは読み込まない。和文は欧文の UI フォントのすぐ後に Hiragino Sans、Yu Gothic UI、Meiryo、Noto Sans JP を並べ、かなや漢字が中国語の既定フォントに落ちないようにする。
- 等幅：run ID、コマンド、数値。数値は `tabular-nums`（`.font-code`、`time`、表のセル、キーと値の値に掛かる）。
- サイズ：12 / 13 / 14 / 16 / 20px。

## Spacing

4px 刻み：4 / 8 / 12 / 16 / 24 / 32 / 48px。Tailwind の `--spacing` を `--space-1` にしているので、`p-3` は `--space-3` になる。この刻みにない値（`gap-1.5` など）は使わない。

## Layout

表と時系列の固定幅だけをトークンにする：`--size-trace-max`（動いている実行の時系列の高さの上限。終わった実行は全行を出す）、`--size-inspector`（詳細の列）、`--size-label`（横並びのキー）、`--size-stage-name` と `--size-stage-value`（工程ごとの時間と費用）、`--size-scroll-margin`（目次から飛んだ見出しを固定ヘッダーの下に出す余白）。時系列は自分の箱の幅で段組みを変える（コンテナクエリ）。

## Radius

4px（バッジ、コード）、6px（ボタン）、10px（パネル）。

## Shadows

パネルは枠線で区切り、影は付けない。影はコピー時の小さな表示（`--shadow-pop`、2層）だけ。

## Motion

常に動くのは、実行中の点の明滅（`--duration-pulse`、1.2s）と時系列の実行中の横棒の光（`--duration-sheen`、2.4s）だけ。ホバーや開閉は `--duration-fast`（150ms）、`--ease-out`。`prefers-reduced-motion` では止める。

## Z-index

`--z-sticky: 20`、`--z-toast: 50`。

## CSS

`src/ui/app.css` の `:root` と同じ内容。

```css
:root {
  color-scheme: light dark;

  /* primitives */
  --gray-50: oklch(98.5% 0.004 250);
  --gray-100: oklch(96% 0.005 250);
  --gray-200: oklch(91% 0.006 250);
  --gray-300: oklch(84% 0.007 250);
  --gray-400: oklch(70% 0.008 250);
  --gray-500: oklch(56% 0.008 250);
  --gray-600: oklch(45% 0.008 250);
  --gray-700: oklch(35% 0.007 250);
  --gray-800: oklch(25% 0.006 250);
  --gray-900: oklch(19% 0.005 250);
  --gray-950: oklch(14% 0.005 250);
  --gray-1000: oklch(11% 0.005 250);
  --white: oklch(100% 0 0);
  --amber-500: oklch(72% 0.15 70);
  --amber-700: oklch(52% 0.13 70);
  --red-500: oklch(60% 0.19 25);
  --red-700: oklch(48% 0.18 25);
  --blue-500: oklch(62% 0.14 250);
  --blue-700: oklch(48% 0.14 250);

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --text-xs: 12px;
  --text-sm: 13px;
  --text-base: 14px;
  --text-lg: 16px;
  --text-xl: 20px;
  /*
   * System fonts only. The Japanese faces come right after the Latin UI
   * fonts, so kana and kanji never fall to a Chinese default.
   */
  --font-sans:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans',
    'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', 'Noto Sans JP',
    system-ui, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --shadow-pop: 0 4px 12px oklch(0% 0 0 / 0.08), 0 1px 3px oklch(0% 0 0 / 0.06);
  --duration-fast: 150ms;
  /*
   * One full cycle of the running dot's slow pulse. It is the UI's only
   * ambient motion, so it is slow enough to read as "alive" without drawing
   * the eye; hover and focus changes use --duration-fast.
   */
  --duration-pulse: 1.2s;
  --duration-sheen: 2.4s;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --z-sticky: 20;
  --z-toast: 50;

  /* layout: the few fixed widths the dense tables and the trace need */
  --size-trace-max: 32rem;
  --size-inspector: 20rem;
  --size-label: 6.5rem;
  --size-stage-name: 9rem;
  --size-stage-value: 5rem;
  --size-scroll-margin: var(--space-12);
  --size-hatch: 4px;

  /* semantics */
  --surface-canvas: light-dark(var(--gray-50), var(--gray-950));
  --surface-raised: light-dark(var(--white), var(--gray-900));
  --surface-sunken: light-dark(var(--gray-100), var(--gray-1000));
  --text-primary: light-dark(var(--gray-900), var(--gray-50));
  --text-secondary: light-dark(var(--gray-600), var(--gray-400));
  --text-tertiary: var(--gray-500);
  --text-inverse: light-dark(var(--white), var(--gray-950));
  --border-subtle: light-dark(oklch(0% 0 0 / 0.07), oklch(100% 0 0 / 0.07));
  --border-default: light-dark(oklch(0% 0 0 / 0.13), oklch(100% 0 0 / 0.13));
  --focus-ring: var(--blue-500);
  --sheen: light-dark(oklch(100% 0 0 / 0.35), oklch(100% 0 0 / 0.18));

  /*
   * Four states. Color is for the three that ask for attention; a finished
   * run, and any state that asks for none, is the neutral `done`.
   */
  --state-waiting: light-dark(var(--amber-700), oklch(78% 0.13 70));
  --state-waiting-bg: light-dark(oklch(97% 0.04 70), oklch(24% 0.04 70));
  --state-failed: light-dark(var(--red-700), oklch(70% 0.16 25));
  --state-failed-bg: light-dark(oklch(97% 0.03 25), oklch(23% 0.04 25));
  --state-running: light-dark(var(--blue-700), oklch(72% 0.12 250));
  --state-running-bg: light-dark(oklch(97% 0.03 250), oklch(23% 0.04 250));
  --state-done: var(--text-secondary);
  --state-done-bg: var(--surface-sunken);
}
```
