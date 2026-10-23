import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// react-native-maps is native-only in this project.  This screen keeps the web
// route usable without pretending that a browser has the same Apple Maps layer.
export default function WebHomeScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.logo}><MaterialCommunityIcons name="city-variant-outline" size={28} color="#FFFFFF" /></View>
          <Text style={styles.eyebrow}>LIVE CITY</Text>
          <Text style={styles.title}>Milano, in movimento.</Text>
          <Text style={styles.subtitle}>
            La mappa interattiva e le superfici di calore sono disponibili nella preview iOS.
          </Text>
        </View>

        <View style={styles.notice}>
          <MaterialCommunityIcons name="information-outline" size={20} color="#176EAE" />
          <Text style={styles.noticeText}>
            Questa preview browser non simula Apple Maps. I dati restano distinti tra live verificato, previsione storica e non disponibile.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Cosa puoi verificare qui</Text>
        <View style={styles.card}>
          <MaterialCommunityIcons name="account-group-outline" size={23} color="#208AEF" />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>Amici e chat privata</Text>
            <Text style={styles.cardText}>Apri la scheda Amici per vedere accesso, follow reciproco e chat con aggiornamento automatico.</Text>
          </View>
        </View>
        <View style={styles.card}>
          <MaterialCommunityIcons name="shield-check-outline" size={23} color="#208AEF" />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>Dati trasparenti</Text>
            <Text style={styles.cardText}>Le previsioni vengono etichettate e non sostituiscono mai un dato live verificato.</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F8FB' },
  content: { padding: 24, gap: 14, maxWidth: 720, width: '100%', alignSelf: 'center' },
  hero: { backgroundColor: '#111B26', borderRadius: 28, padding: 26, minHeight: 240, justifyContent: 'flex-end' },
  logo: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#208AEF', alignItems: 'center', justifyContent: 'center', marginBottom: 28 },
  eyebrow: { color: '#82C6FF', fontWeight: '800', letterSpacing: 1.8, fontSize: 12 },
  title: { color: '#FFFFFF', fontWeight: '800', fontSize: 30, marginTop: 7 },
  subtitle: { color: '#C9D5E0', fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 450 },
  notice: { flexDirection: 'row', gap: 10, backgroundColor: '#E6F4FE', borderRadius: 16, padding: 15, alignItems: 'flex-start' },
  noticeText: { color: '#27638E', fontSize: 13, lineHeight: 19, flex: 1, fontWeight: '600' },
  sectionTitle: { color: '#111111', fontSize: 18, fontWeight: '800', marginTop: 10 },
  card: { flexDirection: 'row', gap: 13, padding: 17, borderRadius: 18, backgroundColor: '#FFFFFF', shadowColor: '#152535', shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  cardBody: { flex: 1 },
  cardTitle: { color: '#111111', fontSize: 15, fontWeight: '800' },
  cardText: { color: '#617080', fontSize: 13, lineHeight: 19, marginTop: 4 },
});
