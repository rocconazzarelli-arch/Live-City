export type DemoAreaHeatCell = {
  id: string;
  latitude: number;
  longitude: number;
  score: number;
  radius: number;
  distinctSessions: 0;
};

/**
 * Product-demo density points for Milan.
 *
 * These points never come from telemetry and must only be rendered when
 * EXPO_PUBLIC_ENABLE_DEMO_HEATMAP=true. Keeping the data in a dedicated module
 * prevents it from being mixed with privacy-safe backend aggregates.
 */
export const DEMO_AREA_HEAT_CELLS: readonly DemoAreaHeatCell[] = [
  { id: 'demo-duomo-core', latitude: 45.4642, longitude: 9.19, score: 96, radius: 310, distinctSessions: 0 },
  { id: 'demo-duomo-east', latitude: 45.4658, longitude: 9.1962, score: 82, radius: 260, distinctSessions: 0 },
  { id: 'demo-cordusio', latitude: 45.4659, longitude: 9.186, score: 86, radius: 270, distinctSessions: 0 },
  { id: 'demo-brera', latitude: 45.4722, longitude: 9.1884, score: 79, radius: 285, distinctSessions: 0 },
  { id: 'demo-garibaldi', latitude: 45.4832, longitude: 9.1873, score: 88, radius: 320, distinctSessions: 0 },
  { id: 'demo-isola', latitude: 45.4885, longitude: 9.1916, score: 73, radius: 250, distinctSessions: 0 },
  { id: 'demo-porta-venezia', latitude: 45.4752, longitude: 9.2057, score: 77, radius: 285, distinctSessions: 0 },
  { id: 'demo-citta-studi', latitude: 45.478, longitude: 9.226, score: 58, radius: 235, distinctSessions: 0 },
  { id: 'demo-navigli-core', latitude: 45.4514, longitude: 9.1744, score: 93, radius: 330, distinctSessions: 0 },
  { id: 'demo-darsena', latitude: 45.4528, longitude: 9.1792, score: 89, radius: 300, distinctSessions: 0 },
  { id: 'demo-porta-genova', latitude: 45.4537, longitude: 9.1697, score: 72, radius: 250, distinctSessions: 0 },
  { id: 'demo-tortona', latitude: 45.4549, longitude: 9.1625, score: 66, radius: 245, distinctSessions: 0 },
  { id: 'demo-colonne', latitude: 45.4585, longitude: 9.1814, score: 84, radius: 270, distinctSessions: 0 },
  { id: 'demo-porta-romana', latitude: 45.4512, longitude: 9.2022, score: 68, radius: 255, distinctSessions: 0 },
  { id: 'demo-sempione', latitude: 45.4774, longitude: 9.1704, score: 61, radius: 260, distinctSessions: 0 },
  { id: 'demo-arco-pace', latitude: 45.4755, longitude: 9.172, score: 74, radius: 245, distinctSessions: 0 },
  { id: 'demo-cadorna', latitude: 45.4681, longitude: 9.1765, score: 70, radius: 245, distinctSessions: 0 },
  { id: 'demo-loreto', latitude: 45.4858, longitude: 9.2152, score: 64, radius: 245, distinctSessions: 0 },
];
