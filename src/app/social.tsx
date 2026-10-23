import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as Linking from 'expo-linking';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  acceptSocialFollow,
  blockSocialUser,
  reportSocialUser,
  clearSocialSession,
  loadSocialSession,
  sendMagicLink,
  sessionFromRedirect,
  SocialSession,
  socialRequest,
  startDirectThread,
} from '@/lib/social-client';

type Profile = { id: string; handle: string; display_name: string; avatar_url: string | null };
type Follow = { follower_id: string; following_id: string; accepted_at: string | null };
type Thread = { id: string; peer: Profile };
type Message = { id: number; sender_id: string; body: string; created_at: string };

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export default function SocialScreen() {
  const [session, setSession] = useState<SocialSession | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Profile[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageDraft, setMessageDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const messageRefreshInFlight = useRef(false);

  const refreshProfile = async (nextSession: SocialSession) => {
    const rows = await socialRequest<Profile[]>(
      nextSession,
      `user_profiles?select=id,handle,display_name,avatar_url&id=eq.${nextSession.userId}`,
    );
    setProfile(rows[0] ?? null);
  };

  const refreshFollows = async (nextSession: SocialSession) => {
    const rows = await socialRequest<Follow[]>(
      nextSession,
      `social_follows?select=follower_id,following_id,accepted_at&or=(follower_id.eq.${nextSession.userId},following_id.eq.${nextSession.userId})`,
    );
    setFollows(rows);
    return rows;
  };

  const refreshFriends = async (nextSession: SocialSession, nextFollows: Follow[]) => {
    const outgoing = new Set(
      nextFollows
        .filter((follow) => follow.follower_id === nextSession.userId && follow.accepted_at !== null)
        .map((follow) => follow.following_id),
    );
    const friendIds = nextFollows
      .filter((follow) => follow.following_id === nextSession.userId && follow.accepted_at !== null)
      .map((follow) => follow.follower_id)
      .filter((friendId) => outgoing.has(friendId));
    if (friendIds.length === 0) {
      setFriends([]);
      return;
    }
    const rows = await socialRequest<Profile[]>(
      nextSession,
      `user_profiles?select=id,handle,display_name,avatar_url&id=in.(${friendIds.join(',')})&order=display_name.asc`,
    );
    setFriends(rows);
  };

  useEffect(() => {
    let mounted = true;
    const bootstrap = async () => {
      try {
        const stored = await loadSocialSession();
        if (!stored || !mounted) return;
        setSession(stored);
        const nextFollows = await refreshFollows(stored);
        await Promise.all([refreshProfile(stored), refreshFriends(stored, nextFollows)]);
      } catch {
        if (mounted) await clearSocialSession();
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void bootstrap();

    const listener = Linking.addEventListener('url', ({ url }) => {
      void sessionFromRedirect(url)
        .then(async (nextSession) => {
          if (!nextSession || !mounted) return;
          setSession(nextSession);
          const nextFollows = await refreshFollows(nextSession);
          await Promise.all([refreshProfile(nextSession), refreshFriends(nextSession, nextFollows)]);
        })
        .catch(() => Alert.alert('Accesso non completato', 'Riprova dal link ricevuto via email.'));
    });
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);

  useEffect(() => {
    if (!session || !profile || query.trim().length < 2) {
      return;
    }
    const timer = setTimeout(() => {
      void socialRequest<Profile[]>(
        session,
        `user_profiles?select=id,handle,display_name,avatar_url&handle=ilike.*${encodeURIComponent(query.trim().toLowerCase())}*&id=neq.${session.userId}&limit=12`,
      ).then(setPeople).catch(() => setPeople([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [profile, query, session]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (value.trim().length < 2) setPeople([]);
  };

  const acceptedFriends = useMemo(() => {
    if (!session) return [];
    const outgoing = new Set(
      follows
        .filter((follow) => follow.follower_id === session.userId && follow.accepted_at !== null)
        .map((follow) => follow.following_id),
    );
    return follows
      .filter((follow) => follow.following_id === session.userId && follow.accepted_at !== null)
      .map((follow) => follow.follower_id)
      .filter((friendId) => outgoing.has(friendId));
  }, [follows, session]);

  const incomingRequests = useMemo(() => {
    if (!session) return [];
    return follows.filter((follow) => follow.following_id === session.userId && follow.accepted_at === null);
  }, [follows, session]);

  const requestLogin = async () => {
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) {
      Alert.alert('Email non valida', 'Inserisci un indirizzo email valido.');
      return;
    }
    setBusy(true);
    try {
      await sendMagicLink(normalized);
      setLinkSent(true);
    } catch {
      Alert.alert('Link non inviato', 'Controlla la configurazione email di Supabase e riprova.');
    } finally {
      setBusy(false);
    }
  };

  const createProfile = async () => {
    if (!session) return;
    const safeHandle = handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(safeHandle) || !displayName.trim()) {
      Alert.alert('Profilo incompleto', 'Scegli un handle di 3–24 caratteri e un nome da mostrare.');
      return;
    }
    setBusy(true);
    try {
      const rows = await socialRequest<Profile[]>(session, 'user_profiles', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ id: session.userId, handle: safeHandle, display_name: displayName.trim() }),
      });
      setProfile(rows[0]);
    } catch {
      Alert.alert('Profilo non creato', 'L’handle potrebbe essere già utilizzato.');
    } finally {
      setBusy(false);
    }
  };

  const requestFollow = async (person: Profile) => {
    if (!session) return;
    setBusy(true);
    try {
      await socialRequest(session, 'social_follows', {
        method: 'POST',
        body: JSON.stringify({ follower_id: session.userId, following_id: person.id }),
      });
      const nextFollows = await refreshFollows(session);
      await refreshFriends(session, nextFollows);
    } catch {
      Alert.alert('Richiesta non inviata', 'Forse segui già questa persona.');
    } finally {
      setBusy(false);
    }
  };

  const acceptFollow = async (request: Follow) => {
    if (!session) return;
    setBusy(true);
    try {
      await acceptSocialFollow(session, request.follower_id);
      const nextFollows = await refreshFollows(session);
      await refreshFriends(session, nextFollows);
    } finally {
      setBusy(false);
    }
  };

  const openThread = async (person: Profile) => {
    if (!session) return;
    setBusy(true);
    try {
      const threadId = await startDirectThread(session, person.id);
      const nextThread = { id: threadId, peer: person };
      setActiveThread(nextThread);
      setMessages([]);
    } catch (error) {
      Alert.alert('Chat non disponibile', error instanceof Error ? error.message : 'Riprova tra poco.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!session || !activeThread) return;
    let cancelled = false;
    const loadMessages = async () => {
      if (messageRefreshInFlight.current) return;
      messageRefreshInFlight.current = true;
      try {
        const rows = await socialRequest<Message[]>(
          session,
          `direct_messages?select=id,sender_id,body,created_at&thread_id=eq.${activeThread.id}&order=created_at.asc`,
        );
        if (!cancelled) setMessages(rows);
      } catch {
        // A temporary network issue must not clear messages already on screen.
      } finally {
        messageRefreshInFlight.current = false;
      }
    };
    void loadMessages();
    const refreshInterval = setInterval(() => void loadMessages(), 8_000);
    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
    };
  }, [activeThread, session]);

  const sendMessage = async () => {
    if (!session || !activeThread || !messageDraft.trim()) return;
    const body = messageDraft.trim();
    if (body.length > 1500) {
      Alert.alert('Messaggio troppo lungo', 'Il limite è di 1.500 caratteri.');
      return;
    }
    setMessageDraft('');
    try {
      const rows = await socialRequest<Message[]>(session, 'direct_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ thread_id: activeThread.id, sender_id: session.userId, body }),
      });
      setMessages((current) => [...current, rows[0]]);
    } catch {
      setMessageDraft(body);
      Alert.alert('Messaggio non inviato', 'Verifica la connessione e riprova.');
    }
  };

  const blockActiveThreadPeer = () => {
    if (!session || !activeThread) return;
    const peer = activeThread.peer;
    Alert.alert(
      `Bloccare ${peer.display_name}?`,
      'Non potrete più iniziare o inviare messaggi in questa chat. Puoi gestire questa scelta in seguito dal tuo profilo.',
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Blocca',
          style: 'destructive',
          onPress: () => {
            void blockSocialUser(session, peer.id)
              .then(async () => {
                const nextFollows = await refreshFollows(session);
                await refreshFriends(session, nextFollows);
                setActiveThread(null);
                setMessages([]);
              })
              .catch(() => Alert.alert('Blocco non riuscito', 'Riprova tra poco.'));
          },
        },
      ],
    );
  };

  const reportActiveThreadPeer = () => {
    if (!session || !activeThread) return;
    const peer = activeThread.peer;
    Alert.alert(
      `Segnalare ${peer.display_name}?`,
      'La segnalazione viene inviata al team di moderazione con il riferimento dell’account. Il contenuto della chat non viene allegato automaticamente.',
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Invia segnalazione',
          style: 'destructive',
          onPress: () => {
            void reportSocialUser(session, peer.id, 'Segnalazione inviata dalla chat privata')
              .then(() => Alert.alert('Segnalazione inviata', 'Grazie. Il team la esaminerà.'))
              .catch(() => Alert.alert('Segnalazione non inviata', 'Riprova tra poco.'));
          },
        },
      ],
    );
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color="#208AEF" /></View>;
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.loginCard}>
          <View style={styles.heroIcon}><MaterialCommunityIcons name="account-group" size={32} color="#FFFFFF" /></View>
          <Text style={styles.title}>La tua cerchia</Text>
          <Text style={styles.subtitle}>Segui gli amici, condividi programmi e scriviti in privato.</Text>
          <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="email@esempio.it" style={styles.input} />
          <Pressable disabled={busy} onPress={() => void requestLogin()} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>{linkSent ? 'Link inviato' : 'Continua con email'}</Text>
          </Pressable>
          {linkSent && <Text style={styles.hint}>Apri il link ricevuto: tornerai qui per creare il profilo.</Text>}
        </View>
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.loginCard}>
          <Text style={styles.title}>Crea il tuo profilo</Text>
          <Text style={styles.subtitle}>L’handle è il nome con cui gli amici ti trovano.</Text>
          <TextInput autoCapitalize="none" value={handle} onChangeText={setHandle} placeholder="es. rocco_milano" style={styles.input} />
          <TextInput value={displayName} onChangeText={setDisplayName} placeholder="Nome da mostrare" style={styles.input} />
          <Pressable disabled={busy} onPress={() => void createProfile()} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Crea profilo</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (activeThread) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.chatHeader}>
          <Pressable onPress={() => setActiveThread(null)}><MaterialCommunityIcons name="chevron-left" size={30} color="#111111" /></Pressable>
          <View style={styles.avatar}><Text style={styles.avatarText}>{initial(activeThread.peer.display_name)}</Text></View>
          <View style={styles.chatHeaderName}><Text style={styles.sectionTitle}>{activeThread.peer.display_name}</Text><Text style={styles.muted}>@{activeThread.peer.handle}</Text></View>
          <Pressable accessibilityLabel={`Blocca ${activeThread.peer.display_name}`} onPress={blockActiveThreadPeer} hitSlop={10}>
            <MaterialCommunityIcons name="account-cancel-outline" size={22} color="#B73535" />
          </Pressable>
          <Pressable accessibilityLabel={`Segnala ${activeThread.peer.display_name}`} onPress={reportActiveThreadPeer} hitSlop={10}>
            <MaterialCommunityIcons name="flag-outline" size={21} color="#B73535" />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.messageList}>
          {messages.length === 0 && <Text style={styles.empty}>Inizia la conversazione.</Text>}
          {messages.map((message) => <View key={message.id} style={[styles.bubble, message.sender_id === session.userId ? styles.bubbleMine : styles.bubbleTheirs]}><Text style={[styles.bubbleText, message.sender_id === session.userId && styles.bubbleTextMine]}>{message.body}</Text></View>)}
        </ScrollView>
        <View style={styles.composer}><TextInput multiline value={messageDraft} onChangeText={setMessageDraft} placeholder="Scrivi un messaggio" style={styles.composerInput} /><Pressable onPress={() => void sendMessage()} style={styles.sendButton}><MaterialCommunityIcons name="send" size={20} color="#FFFFFF" /></Pressable></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}><View><Text style={styles.title}>Ciao, {profile.display_name}</Text><Text style={styles.subtitle}>La tua cerchia a Milano</Text></View><Pressable onPress={() => { void clearSocialSession(); setSession(null); setProfile(null); }}><MaterialCommunityIcons name="logout" size={23} color="#555555" /></Pressable></View>
        <View style={styles.privacy}><MaterialCommunityIcons name="lock-outline" size={17} color="#208AEF" /><Text style={styles.privacyText}>Le chat sono private e si aprono solo tra follow reciproci.</Text></View>
        <Text style={styles.sectionTitle}>Trova amici</Text>
        <TextInput autoCapitalize="none" value={query} onChangeText={handleQueryChange} placeholder="Cerca per @handle" style={styles.input} />
        {people.map((person) => {
          const outgoing = follows.some((follow) => follow.follower_id === session.userId && follow.following_id === person.id);
          const mutual = acceptedFriends.includes(person.id);
          return <View key={person.id} style={styles.personRow}><View style={styles.avatar}><Text style={styles.avatarText}>{initial(person.display_name)}</Text></View><View style={styles.personInfo}><Text style={styles.personName}>{person.display_name}</Text><Text style={styles.muted}>@{person.handle}</Text></View>{mutual ? <Pressable onPress={() => void openThread(person)} style={styles.outlineButton}><MaterialCommunityIcons name="message-text-outline" size={17} color="#208AEF" /><Text style={styles.outlineText}>Chat</Text></Pressable> : <Pressable disabled={outgoing || busy} onPress={() => void requestFollow(person)} style={[styles.followButton, outgoing && styles.followButtonDisabled]}><Text style={styles.followText}>{outgoing ? 'In attesa' : 'Segui'}</Text></Pressable>}</View>;
        })}
        {incomingRequests.length > 0 && <><Text style={styles.sectionTitle}>Richieste ricevute</Text>{incomingRequests.map((request) => <View key={request.follower_id} style={styles.personRow}><View style={styles.avatar}><Text style={styles.avatarText}>?</Text></View><Text style={styles.personInfo}>Nuova richiesta</Text><Pressable onPress={() => void acceptFollow(request)} style={styles.followButton}><Text style={styles.followText}>Accetta</Text></Pressable></View>)}</>}
        <Text style={styles.sectionTitle}>I tuoi amici</Text>
        {friends.length === 0 ? <Text style={styles.empty}>Quando vi seguirete entrambi, qui comparirà la chat privata.</Text> : friends.map((friend) => <View key={friend.id} style={styles.personRow}><View style={styles.avatar}><Text style={styles.avatarText}>{initial(friend.display_name)}</Text></View><View style={styles.personInfo}><Text style={styles.personName}>{friend.display_name}</Text><Text style={styles.muted}>@{friend.handle}</Text></View><Pressable onPress={() => void openThread(friend)} style={styles.outlineButton}><MaterialCommunityIcons name="message-text-outline" size={17} color="#208AEF" /><Text style={styles.outlineText}>Chat</Text></Pressable></View>)}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F7F8FA' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' }, content: { padding: 20, gap: 12 }, loginCard: { margin: 20, marginTop: 100, padding: 24, gap: 12, backgroundColor: '#FFFFFF', borderRadius: 28, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 16, elevation: 4 }, heroIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#208AEF', justifyContent: 'center', alignItems: 'center' }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, title: { color: '#111111', fontSize: 28, fontWeight: '800' }, subtitle: { color: '#707070', fontSize: 14, marginTop: 4, lineHeight: 20 }, sectionTitle: { color: '#111111', fontSize: 17, fontWeight: '800', marginTop: 8 }, input: { backgroundColor: '#FFFFFF', borderColor: '#E4E6EB', borderWidth: 1, borderRadius: 14, paddingHorizontal: 15, paddingVertical: 13, color: '#111111', fontSize: 15 }, primaryButton: { backgroundColor: '#208AEF', alignItems: 'center', borderRadius: 14, paddingVertical: 14 }, primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' }, hint: { color: '#5E6670', fontSize: 13, lineHeight: 18 }, privacy: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: '#EAF5FF', borderRadius: 14 }, privacyText: { color: '#27638E', flex: 1, fontSize: 12, lineHeight: 17, fontWeight: '600' }, personRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }, avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#DDF0FF', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: '#207FCA', fontSize: 16, fontWeight: '800' }, personInfo: { flex: 1 }, personName: { color: '#151515', fontSize: 15, fontWeight: '700' }, muted: { color: '#777777', fontSize: 12 }, followButton: { backgroundColor: '#208AEF', paddingHorizontal: 13, paddingVertical: 9, borderRadius: 12 }, followButtonDisabled: { backgroundColor: '#B5C5D3' }, followText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' }, outlineButton: { flexDirection: 'row', gap: 4, alignItems: 'center', borderWidth: 1, borderColor: '#208AEF', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12 }, outlineText: { color: '#208AEF', fontSize: 12, fontWeight: '800' }, empty: { color: '#7B7B7B', fontSize: 14, lineHeight: 20, paddingVertical: 8 }, chatHeader: { padding: 16, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderBottomColor: '#E8E8E8', borderBottomWidth: 1 }, chatHeaderName: { flex: 1 }, messageList: { padding: 16, gap: 9 }, bubble: { maxWidth: '82%', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 16 }, bubbleMine: { alignSelf: 'flex-end', backgroundColor: '#208AEF', borderBottomRightRadius: 3 }, bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF', borderBottomLeftRadius: 3 }, bubbleText: { color: '#111111', fontSize: 15, lineHeight: 20 }, bubbleTextMine: { color: '#FFFFFF' }, composer: { flexDirection: 'row', gap: 8, padding: 12, backgroundColor: '#FFFFFF', borderTopColor: '#E8E8E8', borderTopWidth: 1, alignItems: 'flex-end' }, composerInput: { flex: 1, maxHeight: 100, backgroundColor: '#F1F3F5', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 }, sendButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#208AEF', alignItems: 'center', justifyContent: 'center' },
});
