import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const APP_HEALTH_URL = 'https://qmskozzidachccwbtejd.supabase.co/functions/v1/app-health';

type ProviderRun = {
  requested_count: number;
  live_written_count: number;
  unavailable_count: number;
  failure_count: number;
  metadata?: { failureReasons?: Record<string, number> } | null;
};

type AppHealth = {
  catalog: { activePlaces: number };
  crowd: {
    latestLiveObservationAt: string | null;
    liveObservationFresh: boolean;
    latestProviderRun: ProviderRun | null;
  };
  heatmap: { latestAggregateAt: string | null; aggregateFresh: boolean; privacyThreshold: number };
};

function formatTime(value: string | null) {
  if (!value) return 'Nessun dato disponibile';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Orario non disponibile';
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
  }).format(date);
}

function getProviderStatus(health: AppHealth) {
  const run = health.crowd.latestProviderRun;
  if (run && run.failure_count > 0) {
    const reason = Object.keys(run.metadata?.failureReasons ?? {})[0];
    const suffix = reason ? ` (${reason.replaceAll('_', ' ')})` : '';
    return `Dati live non disponibili: ${run.failure_count}/${run.requested_count} richieste provider fallite${suffix}`;
  }

  if (health.crowd.latestLiveObservationAt) {
    return `Ultima osservazione: ${formatTime(health.crowd.latestLiveObservationAt)}`;
  }

  return 'Nessuna osservazione live disponibile';
}

function StatusRow({ icon, title, detail, healthy }: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
  detail: string;
  healthy: boolean | null;
}) {
  const color = healthy === null ? '#9AA2AA' : healthy ? '#1B9B5D' : '#D67B00';
  return (
    <View style={styles.statusRow}>
      <View style={[styles.statusIcon, { backgroundColor: `${color}18` }]}>
        <MaterialCommunityIcons name={icon} size={20} color={color} />
      </View>
      <View style={styles.statusCopy}>
        <Text style={styles.statusTitle}>{title}</Text>
        <Text style={styles.statusDetail}>{detail}</Text>
      </View>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
    </View>
  );
}

export default function ExploreScreen() {
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refreshHealth = async () => {
    const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!key) {
      setUnavailable(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(APP_HEALTH_URL, {
        headers: { Authorization: `Bearer ${key}`, apikey: key },
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error('Health endpoint unavailable');
      setHealth(data as AppHealth);
      setUnavailable(false);
    } catch {
      // Informative only: a failed status read must never block the map.
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Defer the first network read until after the initial render. This avoids
    // a synchronous state transition while React is mounting the screen.
    const timer = setTimeout(() => { void refreshHealth(); }, 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}><MaterialCommunityIcons name="city-variant-outline" size={30} color="#FFFFFF" /></View>
          <View style={styles.heroCopy}>
            <Text style={styles.title}>Trasparenza dati</Text>
            <Text style={styles.subtitle}>Stato delle fonti che alimentano LIVE CITY. Le assenze non diventano stime inventate.</Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Stato del servizio</Text>
            <Pressable accessibilityLabel="Aggiorna stato dei dati" onPress={() => void refreshHealth()} style={styles.refreshButton}>
              {loading ? <ActivityIndicator size="small" color="#208AEF" /> : <MaterialCommunityIcons name="refresh" size={19} color="#208AEF" />}
            </Pressable>
          </View>
          {unavailable ? (
            <View style={styles.unavailable}>
              <MaterialCommunityIcons name="cloud-alert-outline" size={22} color="#9A6500" />
              <View style={styles.statusCopy}>
                <Text style={styles.statusTitle}>Stato non raggiungibile</Text>
                <Text style={styles.statusDetail}>La mappa continua a funzionare con gli ultimi dati disponibili.</Text>
              </View>
            </View>
          ) : (
            <>
              <StatusRow icon="map-marker-multiple-outline" title="Catalogo luoghi" detail={health ? `${health.catalog.activePlaces} luoghi attivi nel catalogo` : 'Caricamento catalogo'} healthy={health ? health.catalog.activePlaces > 0 : null} />
              <StatusRow icon="signal-cellular-3" title="Foot traffic live" detail={health ? getProviderStatus(health) : 'Verifica in corso'} healthy={health?.crowd.liveObservationFresh ?? null} />
              <StatusRow icon="blur" title="Heatmap territoriale" detail={health ? `Ultimo aggregato: ${formatTime(health.heatmap.latestAggregateAt)}` : 'Verifica in corso'} healthy={health?.heatmap.aggregateFresh ?? null} />
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Come leggere la mappa</Text>
          <View style={styles.explainerRow}><View style={[styles.legendDot, { backgroundColor: '#1B9B5D' }]} /><Text style={styles.explainer}>Dato live: osservazione BestTime disponibile o presenze LIVE CITY aggregate.</Text></View>
          <View style={styles.explainerRow}><View style={[styles.legendDot, { backgroundColor: '#D67B00' }]} /><Text style={styles.explainer}>Stima: previsione calcolata esclusivamente da osservazioni reali storicizzate.</Text></View>
          <View style={styles.explainerRow}><View style={[styles.legendDot, { backgroundColor: '#9AA2AA' }]} /><Text style={styles.explainer}>Non disponibile: non esiste un segnale affidabile da mostrare.</Text></View>
        </View>

        <View style={styles.privacyCard}>
          <MaterialCommunityIcons name="shield-account-outline" size={26} color="#208AEF" />
          <View style={styles.statusCopy}>
            <Text style={styles.cardTitle}>La tua posizione resta sotto il tuo controllo</Text>
            <Text style={styles.explainer}>La condivisione è facoltativa, solo con app aperta. Le zone diventano visibili solo da {health?.heatmap.privacyThreshold ?? 5} sessioni distinte e non mostrano percorsi individuali.</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F8FA' },
  content: { padding: 20, gap: 14, paddingBottom: 44 },
  hero: { flexDirection: 'row', gap: 13, alignItems: 'center', marginTop: 8, marginBottom: 2 },
  heroIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: '#208AEF', alignItems: 'center', justifyContent: 'center' },
  heroCopy: { flex: 1 },
  title: { color: '#121212', fontSize: 26, fontWeight: '800' },
  subtitle: { color: '#68717B', fontSize: 13, lineHeight: 19, marginTop: 3 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 16, gap: 13, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 10, elevation: 2 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { color: '#171717', fontSize: 16, fontWeight: '800' },
  refreshButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#EAF5FF', alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  statusIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  statusCopy: { flex: 1 },
  statusTitle: { color: '#222222', fontSize: 14, fontWeight: '700' },
  statusDetail: { color: '#727982', fontSize: 12, lineHeight: 17, marginTop: 2 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  unavailable: { flexDirection: 'row', gap: 11, alignItems: 'center', backgroundColor: '#FFF8E9', borderRadius: 14, padding: 12 },
  explainerRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  legendDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  explainer: { color: '#626B75', fontSize: 13, lineHeight: 19, flex: 1 },
  privacyCard: { flexDirection: 'row', gap: 12, backgroundColor: '#EAF5FF', borderRadius: 20, padding: 16 },
});
