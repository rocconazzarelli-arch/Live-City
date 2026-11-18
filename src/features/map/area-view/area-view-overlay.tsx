import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FOCUS_LEVELS, type FocusPeak } from '@/features/map/focus-zones/focus-zones';
import { gatheringKindLabel } from '@/features/map/focus-zones/gathering-kind';

/**
 * Chrome of the 3D area view: a back button and a dark glass card describing
 * the selected gathering. The map itself (tilted camera, dark style, 3D
 * buildings) is driven by the map screen.
 */
export function AreaViewOverlay({
  peak,
  accentColor,
  isSimulation,
  onClose,
}: {
  peak: FocusPeak;
  accentColor: string;
  isSimulation: boolean;
  onClose: () => void;
}) {
  const kindLabel = gatheringKindLabel(peak.kind);
  return (
    <SafeAreaView pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn.duration(300).delay(500)} exiting={FadeOut.duration(200)} pointerEvents="box-none">
        <Pressable
          onPress={onClose}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Torna alla mappa"
        >
          <MaterialCommunityIcons name="chevron-left" size={22} color="#FFFFFF" />
          <Text style={styles.backText}>Mappa</Text>
        </Pressable>
      </Animated.View>

      <View style={styles.spacer} pointerEvents="none" />

      <Animated.View
        entering={FadeInDown.duration(450).delay(900)}
        exiting={FadeOutDown.duration(200)}
        style={styles.card}
      >
        <View style={styles.cardHeader}>
          <View style={[styles.accentDot, { backgroundColor: accentColor }]} />
          <Text style={[styles.label, { color: accentColor }]}>{peak.label.toUpperCase()}</Text>
          {isSimulation && <Text style={styles.simulation}>SIMULAZIONE</Text>}
        </View>
        <Text style={styles.name} numberOfLines={1}>{peak.name}</Text>
        <View style={styles.levelRow}>
          {FOCUS_LEVELS.map((level, index) => (
            <View
              key={level.threshold}
              style={[
                styles.levelBar,
                { backgroundColor: peak.score >= level.threshold ? level.color : 'rgba(255, 255, 255, 0.14)' },
                index === FOCUS_LEVELS.length - 1 && styles.levelBarLast,
              ]}
            />
          ))}
          <Text style={styles.levelText}>{crowdLevelLabel(peak.score)}</Text>
        </View>
        {kindLabel !== null && peak.stationaryShare !== null && (
          <Text style={styles.kind}>
            {`${kindLabel} · circa ${Math.round(peak.stationaryShare * 100)}% fermi`}
          </Text>
        )}
        <Text style={styles.hint}>Le zone rosse indicano dove la folla è più fitta.</Text>
      </Animated.View>
    </SafeAreaView>
  );
}

function crowdLevelLabel(score: number): string {
  if (score >= FOCUS_LEVELS[2].threshold) return 'Pieno';
  if (score >= FOCUS_LEVELS[1].threshold) return 'Molto affollato';
  return 'Affollato';
}

const styles = StyleSheet.create({
  backButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginLeft: 16,
    paddingLeft: 6,
    paddingRight: 14,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(17, 19, 24, 0.82)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },

  backText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },

  spacer: {
    flex: 1,
  },

  card: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 18,
    borderRadius: 22,
    backgroundColor: 'rgba(17, 19, 24, 0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    gap: 6,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },

  accentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  label: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
  },

  simulation: {
    marginLeft: 'auto',
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },

  name: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
  },

  levelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },

  levelBar: {
    width: 26,
    height: 6,
    borderRadius: 3,
  },

  levelBarLast: {
    marginRight: 6,
  },

  levelText: {
    color: 'rgba(255, 255, 255, 0.86)',
    fontSize: 13,
    fontWeight: '700',
  },

  kind: {
    color: 'rgba(255, 255, 255, 0.86)',
    fontSize: 13,
    fontWeight: '600',
  },

  hint: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 12,
    marginTop: 2,
  },
});
