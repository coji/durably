# Design Tokens

対象はファクトリーの web UI（`examples/local-agent-loop`）。brief の原則4「色は状態を表すためだけに使う」に従い、ブランドのアクセントは持たない。CSS は web UI の実装時に作る（Tailwind v4 の `@theme` に移せる形）。

## Colors

- 中立色：わずかに寒色寄りのグレー（OKLCH、hue 250、chroma 0.004〜0.008）。
- 状態色は3つだけ。人待ち＝琥珀、失敗＝赤、実行中＝青。成功して終わった run は色を付けない。
- ダークモードは OS 設定に従う。真っ黒は使わず、状態色は彩度を約1割落とす。

## Typography

- 本文：システムフォント（`system-ui`）、14px。Web フォントは読み込まない。
- 等幅：run ID、コマンド、数値。数値は `tabular-nums`。
- サイズ：12 / 13 / 14 / 16 / 20px。

## Spacing

4px 刻み：4 / 8 / 12 / 16 / 24 / 32 / 48px。

## Radius

4px（バッジ、コード）、6px（ボタン）、10px（パネル）。

## Shadows

パネルは枠線で区切り、影は付けない。影はコピー時の小さな表示（`--shadow-pop`、2層）だけ。

## Motion

実行中の点の明滅だけ。150ms、`--ease-out`。`prefers-reduced-motion` では止める。

## Z-index

`--z-sticky: 20`、`--z-toast: 50`。

## CSS

```css
:root {
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
  --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --shadow-pop: 0 4px 12px oklch(0% 0 0 / 0.08), 0 1px 3px oklch(0% 0 0 / 0.06);
  --duration-fast: 150ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --z-sticky: 20;
  --z-toast: 50;

  /* semantics (light) */
  --surface-canvas: var(--gray-50);
  --surface-raised: #fff;
  --surface-sunken: var(--gray-100);
  --text-primary: var(--gray-900);
  --text-secondary: var(--gray-600);
  --text-tertiary: var(--gray-500);
  --border-subtle: oklch(0% 0 0 / 0.07);
  --border-default: oklch(0% 0 0 / 0.13);
  --focus-ring: var(--blue-500);
  --state-waiting: var(--amber-700);
  --state-waiting-bg: oklch(97% 0.04 70);
  --state-failed: var(--red-700);
  --state-failed-bg: oklch(97% 0.03 25);
  --state-running: var(--blue-700);
  --state-running-bg: oklch(97% 0.03 250);
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface-canvas: var(--gray-950);
    --surface-raised: var(--gray-900);
    --surface-sunken: oklch(11% 0.005 250);
    --text-primary: var(--gray-50);
    --text-secondary: var(--gray-400);
    --text-tertiary: var(--gray-500);
    --border-subtle: oklch(100% 0 0 / 0.07);
    --border-default: oklch(100% 0 0 / 0.13);
    --state-waiting: oklch(78% 0.13 70);
    --state-waiting-bg: oklch(24% 0.04 70);
    --state-failed: oklch(70% 0.16 25);
    --state-failed-bg: oklch(23% 0.04 25);
    --state-running: oklch(72% 0.12 250);
    --state-running-bg: oklch(23% 0.04 250);
  }
}
```
