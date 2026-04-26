# growi-plugin-drawio-converter

GROWI の view 画面に表示された drawio 図を、**drawio 本体の「画像としてコピー」と同等の再現度** で SVG / PNG としてダウンロードできるプラグイン。

編集ボタン直下に `SVG` / `PNG` ボタンが追加され、クリック 1 回で DL できる。

## 依存

- GROWI v7.x 以上（extension-hub が動く版）
- [`growi-plugin-extension-hub`](https://gitea.drupal-yattemiyo.com/growi-plugins/growi-plugin-extension-hub) がインストール・有効化されていること
- GROWI の drawio 設定が有効（`viewer-static.min.js` がロードされる状態）

## 機能

- 編集ボタン直下に `SVG` `PNG` の 2 ボタンを追加
- SVG: フォント埋め込み済み、オフラインでも他ビューアで崩れない
- PNG: 2 倍解像度、背景色はライト/ダークモードに連動
- ファイル名: `drawio-<pageId>-<revisionId>-<blockIndex>.{svg,png}`
- extension-hub 設定から ON/OFF、debug ログ表示の切替が可能

## 仕組み

- **SVG**: `.mxgraph` の `data-mxgraph` から mxfile XML を抽出し、オフスクリーンの div で `GraphViewer.createViewerForElement` を呼んで新しい viewer を構築、`viewer.graph.getSvg(...)` で drawio 本体と同じレンダラーで SVG を生成する。
- **PNG**: hidden iframe で drawio Editor を `?embed=1&proto=json&configure=1` で読み込み、postMessage API で mxfile XML を渡して drawio 本体と同一の export パイプラインから PNG を受け取る。旧来のクライアント側ラスタライズ（foreignObject → canvas）は `png-legacy/` に退避してあり、localStorage / URL クエリで手動切替可能（「開発」節参照）。
  - `configure=1` を付けて起動直後に `{action:'configure', config:{fitDiagramOnLoad:false, fitDiagramOnPage:false}}` を投げているのは、drawio v29.6.2 で追加された自動フィット (#5415) が `setFileData` 直後の export を破壊する regression を回避するため。具体的には、source/target セルを持たない floating-point edge と空 geometry の `edgeLabel` が、export 結果の SVG/PNG から脱落する。詳しくは隣接プロジェクト `test-drawio-version-checker/test_drawio_png_convert_report.md` を参照。

## インストール

GROWI 管理画面 → プラグイン → 新規登録 → このリポジトリの URL を指定。

## 開発

```bash
npm install
npm run build
```

`dist/` はリポジトリに commit する（GROWI がビルド済みアセットを直接読み込むため）。

### PNG export の手動切替（開発・調査用）

新パス（drawio-native embed 経由）と旧パス（foreignObject ラスタライズ）を手動で切り替えられる。通常運用では使わず、新パスで不具合調査したいときの退避口として用意している。

- 常用切替 ON: DevTools で `localStorage.setItem('drawio-converter.legacyPng', '1')`
- 常用切替 OFF: `localStorage.removeItem('drawio-converter.legacyPng')`
- 1 ページだけ旧パス: URL に `?drawio-legacy-png=1`
- 1 ページだけ新パス: `?drawio-legacy-png=0`（localStorage の ON を一時無効化）

評価順は URL クエリ > localStorage > default (embed)。

## ドキュメント

- 設計: `docs/superpowers/specs/2026-04-21-drawio-converter-design.md`
- 実装プラン: `docs/superpowers/plans/2026-04-21-drawio-converter.md`
- E2E シナリオ: `docs/e2e-scenarios.md`
- Phase 1 検証結果: `docs/phase1-findings.md`

## ライセンス

MIT
