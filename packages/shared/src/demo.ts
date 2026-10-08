import type { KnowledgeDocument, ConversationStatePatch, TranscriptSegment } from './index';
export const DEMO_ORG = 'demo-north';
export const DEMO_SCENARIO = [
  { role: 'consultant' as const, text: 'Здравствуйте! Чем могу помочь?' },
  {
    role: 'customer' as const,
    text: 'Добрый день. Потерял телефон, нужно восстановить сим-карту и сохранить свой номер.',
  },
  {
    role: 'consultant' as const,
    text: 'Понимаю. Номер оформлен на вас? Документ, удостоверяющий личность, с собой?',
  },
  {
    role: 'customer' as const,
    text: 'Да, на меня. Паспорт с собой. И ещё хочу посмотреть недорогой телефон — до 20 тысяч.',
  },
];
const templates = [
  {
    title: 'Замена и восстановление SIM-карты',
    type: 'process' as const,
    intent: 'sim_replacement',
    direction: 'service' as const,
    description: 'Потеря телефона, повреждение или замена SIM. Учебный регламент.',
    content:
      'Уточните, на кого оформлен номер, и попросите документ, удостоверяющий личность.\n\nПроверьте владельца номера по учебному регламенту идентификации. До завершения проверки не переходите к замене SIM.\n\nПосле подтверждения владельца оформите замену SIM в системе оператора. Назовите стоимость только по действующему каталогу.\n\nПопросите клиента проверить звонок и доступ к сети. Закройте обращение после подтверждения результата.',
  },
  {
    title: 'Подбор тарифа по потребностям',
    type: 'process' as const,
    intent: 'tariff_selection',
    direction: 'sales' as const,
    description: 'Интернет, звонки, бюджет и дополнительные пакеты.',
    content:
      'Уточните, сколько интернета и минут использует клиент, какой бюджет комфортен и нужен ли домашний интернет.\n\nСравните подходящие тарифы по опубликованным условиям. Если расход неизвестен, предложите сначала посмотреть статистику использования.\n\nУчебный тариф «Связь»: 30 ГБ и 600 минут за 650 ₽ в месяц. Предложение вымышленное и используется только для демонстрации.',
  },
  {
    title: 'Смартфоны до 20 000 ₽',
    type: 'catalog' as const,
    intent: 'device_selection',
    direction: 'sales' as const,
    description: 'Учебный каталог. Остатки требуют проверки.',
    content:
      'Уточните бюджет, важность камеры, объёма памяти и времени работы.\n\nВ учебном каталоге есть «Nord A1»: 128 ГБ, 18 990 ₽. Наличие необходимо проверить. Это вымышленная модель для демонстрации.\n\nПредложите подобрать совместимый чехол и защитное стекло. Стоимость берите из актуального каталога аксессуаров.',
  },
  {
    title: 'Домашний интернет: проверка адреса',
    type: 'process' as const,
    intent: 'home_internet',
    direction: 'sales' as const,
    description: 'Проверка технической возможности и пожеланий клиента.',
    content:
      'Уточните адрес подключения и задачи: работа, игры, видео или несколько устройств.\n\nПроверьте техническую возможность по адресу в системе оператора. До проверки не обещайте подключение и сроки.',
  },
  {
    title: 'Аксессуары и совместимость',
    type: 'catalog' as const,
    intent: 'accessories',
    direction: 'sales' as const,
    description: 'Чехлы, защита экрана, зарядные устройства.',
    content:
      'Уточните точную модель устройства и тип разъёма.\n\nПроверьте совместимость аксессуара по его описанию. Если модель неизвестна, попросите показать её в настройках телефона.',
  },
  {
    title: 'Работа с возражением «Дорого»',
    type: 'article' as const,
    intent: 'price_objection',
    direction: 'sales' as const,
    description: 'Потребность важнее скидки. Учебная памятка.',
    content:
      'Уточните, с чем клиент сравнивает цену и какой бюджет ему подходит.\n\nПредложите сравнить только нужные клиенту возможности. Не обещайте скидки, которых нет в опубликованных условиях.',
  },
];
export function demoDocuments(orgId = DEMO_ORG): KnowledgeDocument[] {
  const now = new Date().toISOString();
  return templates.map((d, i) => ({
    ...d,
    id: `demo-doc-${i + 1}`,
    orgId,
    region: 'Все регионы',
    version: 1,
    status: 'published',
    validFrom: '',
    validUntil: '',
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    sourceName: 'Учебная база Суфлёра',
    sourceKey: null,
    error: null,
    indexedVersion: null,
    blocks: d.content
      .split('\n\n')
      .map((text, j) => ({
        id: `demo-block-${i + 1}-${j + 1}`,
        text,
        kind:
          d.type === 'process'
            ? 'step'
            : j === 0
              ? 'question'
              : d.type === 'catalog'
                ? 'offer'
                : 'step',
        requiredFacts: i === 0 && j === 2 ? ['demo-block-1-2'] : [],
      })),
  }));
}
export function demoClassification(segments: TranscriptSegment[]): ConversationStatePatch {
  const text = segments
    .filter((s) => s.role === 'customer' && !s.excluded)
    .map((s) => s.text)
    .join(' ')
    .toLowerCase();
  const sim = /сим|sim|потерял/.test(text),
    device = /телефон.*тысяч|смартфон|купить телефон/.test(text),
    tariff = /тариф|гигабайт|минут/.test(text),
    home = /домашн.*интернет/.test(text),
    access = /чехол|стекло|заряд/.test(text);
  const sales = device || tariff || home || access;
  const intent = sim
    ? 'sim_replacement'
    : device
      ? 'device_selection'
      : tariff
        ? 'tariff_selection'
        : home
          ? 'home_internet'
          : access
            ? 'accessories'
            : 'unknown';
  return {
    direction: sim && sales ? 'mixed' : sim ? 'service' : sales ? 'sales' : 'unknown',
    intent,
    secondaryIntents: sim && device ? ['device_selection'] : [],
    stage: sim ? 'clarification' : 'discovery',
    needs: [...(sim ? ['Сохранить номер'] : []), ...(device ? ['Подобрать смартфон'] : [])],
    objections: /дорого/.test(text) ? ['Цена'] : [],
    missing: sim ? ['Подтвердить владельца номера'] : [],
    facts: [],
    shouldHint: sim || sales,
    ending: /спасибо.*до свидания|всё.*спасибо/.test(text),
    confidence: 0.93,
  };
}
