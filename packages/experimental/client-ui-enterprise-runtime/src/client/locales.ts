/** Locale-owned copy for the Enterprise Runtime detail and user application plaza. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'enterpriseRuntime'

export const zh = {
  heading: '企业能力原型', intro: 'Runtime API v1 返回无损 JSON，并且只接受声明式模板。',
  list: '列表：可查询的集合。', detail: '详情：单条记录的选定字段。', chart: '图表：柱状、折线或饼图数据投影。', report: '报表：有序的 JSON 安全章节。',
  langfuse: 'Langfuse 示例：所选时间段记录了多少条 trace？不随包提供 Langfuse 连接器。',
  panel: '自生长引擎', introPlaza: '由已安装企业应用包驱动的应用广场。', empty: '尚未安装可展示的企业小应用。', back: '返回应用广场',
  'demo.list': '已安装 ZIP 的声明式列表结果。', 'demo.listResult': 'Orders', 'demo.detail': '已安装 ZIP 声明的详情字段。',
  'demo.value': '已由受控 Runtime 投影', 'demo.chart': '{chart} 图：{x} 与 {y} 的声明式投影。', 'demo.chartResult': '订单状态图表',
  'demo.report': '已安装 ZIP 声明的报表章节。',
} satisfies Record<string, string>

export type EnterpriseRuntimeLocaleKey = keyof typeof zh

export const en = {
  heading: 'Enterprise capability prototypes', intro: 'Runtime API v1 returns lossless JSON and accepts only declarative templates.',
  list: 'List: a queryable collection.', detail: 'Detail: selected fields for one record.', chart: 'Chart: bar, line, or pie data projection.', report: 'Report: ordered JSON-safe sections.',
  langfuse: 'Langfuse example: How many traces were recorded in the selected period? No Langfuse connector is bundled.',
  panel: 'Self-growing Engine', introPlaza: 'An application plaza driven by installed enterprise application packages.', empty: 'No installed enterprise applications are available yet.', back: 'Back to application plaza',
  'demo.list': 'Declarative list result from the installed ZIP.', 'demo.listResult': 'Orders', 'demo.detail': 'Detail fields declared by the installed ZIP.',
  'demo.value': 'Projected by the controlled Runtime', 'demo.chart': '{chart} chart: declarative projection of {x} by {y}.', 'demo.chartResult': 'Order status chart',
  'demo.report': 'Report sections declared by the installed ZIP.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const ja = {
  ...en,
  heading: 'エンタープライズ機能のプロトタイプ', intro: 'Runtime API v1 は損失のない JSON を返し、宣言的テンプレートのみを受け入れます。',
  list: 'リスト：照会可能なコレクション。', detail: '詳細：1 件のレコードの選択フィールド。', chart: 'グラフ：棒、折れ線、または円のデータ投影。', report: 'レポート：順序付きの JSON 安全なセクション。',
  langfuse: 'Langfuse の例：選択期間に記録されたトレース数は？ Langfuse コネクタは同梱しません。',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const es = {
  ...en,
  heading: 'Prototipos de capacidades empresariales', intro: 'Runtime API v1 devuelve JSON sin pérdidas y solo acepta plantillas declarativas.',
  list: 'Lista: una colección consultable.', detail: 'Detalle: campos seleccionados de un registro.', chart: 'Gráfico: proyección de datos de barras, líneas o sectores.', report: 'Informe: secciones ordenadas y seguras para JSON.',
  langfuse: 'Ejemplo Langfuse: ¿cuántas trazas se registraron en el período seleccionado? No se incluye ningún conector de Langfuse.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const fr = {
  ...en,
  heading: 'Prototypes de capacités d’entreprise', intro: 'Runtime API v1 renvoie du JSON sans perte et accepte uniquement des modèles déclaratifs.',
  list: 'Liste : une collection interrogeable.', detail: 'Détail : champs sélectionnés pour un enregistrement.', chart: 'Graphique : projection de données en barres, lignes ou secteurs.', report: 'Rapport : sections ordonnées compatibles JSON.',
  langfuse: 'Exemple Langfuse : combien de traces ont été enregistrées pendant la période sélectionnée ? Aucun connecteur Langfuse n’est inclus.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const de = {
  ...en,
  heading: 'Prototypen für Unternehmensfunktionen', intro: 'Runtime API v1 liefert verlustfreies JSON und akzeptiert nur deklarative Vorlagen.',
  list: 'Liste: eine abfragbare Sammlung.', detail: 'Details: ausgewählte Felder eines Datensatzes.', chart: 'Diagramm: Balken-, Linien- oder Kreisdatendarstellung.', report: 'Bericht: geordnete JSON-sichere Abschnitte.',
  langfuse: 'Langfuse-Beispiel: Wie viele Traces wurden im ausgewählten Zeitraum aufgezeichnet? Es ist kein Langfuse-Connector enthalten.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const ru = {
  ...en,
  heading: 'Прототипы корпоративных возможностей', intro: 'Runtime API v1 возвращает JSON без потерь и принимает только декларативные шаблоны.',
  list: 'Список: коллекция, доступная для запроса.', detail: 'Сведения: выбранные поля одной записи.', chart: 'Диаграмма: столбчатая, линейная или круговая проекция данных.', report: 'Отчёт: упорядоченные JSON-безопасные разделы.',
  langfuse: 'Пример Langfuse: сколько трасс записано за выбранный период? Коннектор Langfuse не включён.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const pt = {
  ...en,
  heading: 'Protótipos de recursos empresariais', intro: 'Runtime API v1 retorna JSON sem perdas e aceita apenas modelos declarativos.',
  list: 'Lista: uma coleção consultável.', detail: 'Detalhe: campos selecionados de um registro.', chart: 'Gráfico: projeção de dados em barras, linhas ou pizza.', report: 'Relatório: seções ordenadas seguras para JSON.',
  langfuse: 'Exemplo Langfuse: quantos rastreamentos foram registrados no período selecionado? Nenhum conector Langfuse é incluído.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { enterpriseRuntime: EnterpriseRuntimeLocaleKey }
}
