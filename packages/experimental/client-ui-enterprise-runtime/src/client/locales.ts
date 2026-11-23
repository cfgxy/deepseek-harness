/** Locale-owned copy for the Enterprise Runtime Plugin Manager contribution. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace shared by the Plugin Manager slot and its component. */
export const NS = 'enterpriseRuntime'

/** Chinese dictionary and key source. */
export const zh = {
  heading: '企业能力原型',
  intro: 'Runtime API v1 返回无损 JSON，并且只接受声明式模板。',
  list: '列表：可查询的集合。',
  detail: '详情：单条记录的选定字段。',
  chart: '图表：柱状、折线或饼图数据投影。',
  report: '报表：有序的 JSON 安全章节。',
  langfuse: 'Langfuse 示例：所选时间段记录了多少条 trace？不随包提供 Langfuse 连接器。',
} satisfies Record<string, string>

/** Keys shared by every dictionary. */
export type EnterpriseRuntimeLocaleKey = keyof typeof zh

export const en = {
  heading: 'Enterprise capability prototypes',
  intro: 'Runtime API v1 returns lossless JSON and accepts only declarative templates.',
  list: 'List: a queryable collection.',
  detail: 'Detail: selected fields for one record.',
  chart: 'Chart: bar, line, or pie data projection.',
  report: 'Report: ordered JSON-safe sections.',
  langfuse: 'Langfuse example: How many traces were recorded in the selected period? No Langfuse connector is bundled.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const ja = {
  heading: 'エンタープライズ機能のプロトタイプ',
  intro: 'Runtime API v1 は損失のない JSON を返し、宣言的テンプレートのみを受け入れます。',
  list: 'リスト：照会可能なコレクション。',
  detail: '詳細：1 件のレコードの選択フィールド。',
  chart: 'グラフ：棒、折れ線、または円のデータ投影。',
  report: 'レポート：順序付きの JSON 安全なセクション。',
  langfuse: 'Langfuse の例：選択期間に記録されたトレース数は？ Langfuse コネクタは同梱しません。',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const es = {
  heading: 'Prototipos de capacidades empresariales',
  intro: 'Runtime API v1 devuelve JSON sin pérdidas y solo acepta plantillas declarativas.',
  list: 'Lista: una colección consultable.',
  detail: 'Detalle: campos seleccionados de un registro.',
  chart: 'Gráfico: proyección de datos de barras, líneas o sectores.',
  report: 'Informe: secciones ordenadas y seguras para JSON.',
  langfuse: 'Ejemplo de Langfuse: ¿cuántas trazas se registraron en el período seleccionado? No se incluye ningún conector de Langfuse.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const fr = {
  heading: 'Prototypes de capacités d’entreprise',
  intro: 'Runtime API v1 renvoie du JSON sans perte et accepte uniquement des modèles déclaratifs.',
  list: 'Liste : une collection interrogeable.',
  detail: 'Détail : champs sélectionnés pour un enregistrement.',
  chart: 'Graphique : projection de données en barres, lignes ou secteurs.',
  report: 'Rapport : sections ordonnées compatibles JSON.',
  langfuse: 'Exemple Langfuse : combien de traces ont été enregistrées pendant la période sélectionnée ? Aucun connecteur Langfuse n’est inclus.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const de = {
  heading: 'Prototypen für Unternehmensfunktionen',
  intro: 'Runtime API v1 liefert verlustfreies JSON und akzeptiert nur deklarative Vorlagen.',
  list: 'Liste: eine abfragbare Sammlung.',
  detail: 'Details: ausgewählte Felder eines Datensatzes.',
  chart: 'Diagramm: Balken-, Linien- oder Kreisdatendarstellung.',
  report: 'Bericht: geordnete JSON-sichere Abschnitte.',
  langfuse: 'Langfuse-Beispiel: Wie viele Traces wurden im ausgewählten Zeitraum aufgezeichnet? Es ist kein Langfuse-Connector enthalten.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const ru = {
  heading: 'Прототипы корпоративных возможностей',
  intro: 'Runtime API v1 возвращает JSON без потерь и принимает только декларативные шаблоны.',
  list: 'Список: коллекция, доступная для запроса.',
  detail: 'Сведения: выбранные поля одной записи.',
  chart: 'Диаграмма: столбчатая, линейная или круговая проекция данных.',
  report: 'Отчёт: упорядоченные JSON-безопасные разделы.',
  langfuse: 'Пример Langfuse: сколько трасс записано за выбранный период? Коннектор Langfuse не включён.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

export const pt = {
  heading: 'Protótipos de recursos empresariais',
  intro: 'Runtime API v1 retorna JSON sem perdas e aceita apenas modelos declarativos.',
  list: 'Lista: uma coleção consultável.',
  detail: 'Detalhe: campos selecionados de um registro.',
  chart: 'Gráfico: projeção de dados em barras, linhas ou pizza.',
  report: 'Relatório: seções ordenadas seguras para JSON.',
  langfuse: 'Exemplo Langfuse: quantos rastreamentos foram registrados no período selecionado? Nenhum conector Langfuse é incluído.',
} satisfies Record<EnterpriseRuntimeLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    enterpriseRuntime: EnterpriseRuntimeLocaleKey
  }
}
