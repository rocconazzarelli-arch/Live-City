/**
 * Recognisable micro-areas of Milan used to name focus zones ("Darsena",
 * "Colonne di San Lorenzo"…). Coordinates point at the public space people
 * actually gather in, not at an administrative centroid.
 */
export type Landmark = {
  name: string;
  latitude: number;
  longitude: number;
};

export const MILAN_LANDMARKS: readonly Landmark[] = [
  { name: 'Piazza Duomo', latitude: 45.4641, longitude: 9.1919 },
  { name: 'Galleria', latitude: 45.4659, longitude: 9.19 },
  { name: 'Corso Vittorio Emanuele', latitude: 45.4652, longitude: 9.1965 },
  { name: 'San Babila', latitude: 45.4664, longitude: 9.1993 },
  { name: 'Cordusio', latitude: 45.4652, longitude: 9.1862 },
  { name: 'Via Torino', latitude: 45.4612, longitude: 9.1858 },
  { name: 'Castello Sforzesco', latitude: 45.4705, longitude: 9.1795 },
  { name: 'Parco Sempione', latitude: 45.4728, longitude: 9.1752 },
  { name: 'Arco della Pace', latitude: 45.4757, longitude: 9.1724 },
  { name: 'Corso Sempione', latitude: 45.4788, longitude: 9.1685 },
  { name: 'Brera', latitude: 45.4719, longitude: 9.1878 },
  { name: 'Corso Garibaldi', latitude: 45.4773, longitude: 9.1857 },
  { name: 'Corso Como', latitude: 45.4822, longitude: 9.1878 },
  { name: 'Piazza Gae Aulenti', latitude: 45.4838, longitude: 9.1898 },
  { name: 'Biblioteca degli Alberi', latitude: 45.4836, longitude: 9.1935 },
  { name: 'Isola', latitude: 45.4886, longitude: 9.1898 },
  { name: 'Chinatown', latitude: 45.4799, longitude: 9.1762 },
  { name: 'Porta Venezia', latitude: 45.4768, longitude: 9.2068 },
  { name: 'Lazzaretto', latitude: 45.4795, longitude: 9.2048 },
  { name: 'Giardini Montanelli', latitude: 45.4737, longitude: 9.2005 },
  { name: 'Corso Buenos Aires', latitude: 45.4818, longitude: 9.2101 },
  { name: 'NoLo', latitude: 45.4988, longitude: 9.2192 },
  { name: 'Città Studi', latitude: 45.4785, longitude: 9.2275 },
  { name: 'Colonne di San Lorenzo', latitude: 45.4583, longitude: 9.1813 },
  { name: 'Darsena', latitude: 45.4527, longitude: 9.1791 },
  { name: 'Naviglio Grande', latitude: 45.4511, longitude: 9.1722 },
  { name: 'Naviglio Pavese', latitude: 45.4482, longitude: 9.1778 },
  { name: 'Porta Genova', latitude: 45.4535, longitude: 9.1688 },
  { name: 'Tortona', latitude: 45.4548, longitude: 9.1628 },
  { name: 'Porta Romana', latitude: 45.4512, longitude: 9.2022 },
  { name: 'Fondazione Prada', latitude: 45.4447, longitude: 9.2044 },
  { name: 'CityLife', latitude: 45.4777, longitude: 9.1553 },
];
