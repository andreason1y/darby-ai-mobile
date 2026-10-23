import { Link, router } from "expo-router";
import { useState } from "react";
import { Button, Pressable, ScrollView, Text, View } from "react-native";
import { api, type Conversation } from "../src/api";
import { serverUrl, useSession } from "../src/auth";
import { card, colors, muted } from "../src/ui";

const legalCoworkers = [
  {
    id: "general-counsel",
    name: "General Counsel",
    title: "Lead In-House Counsel",
  },
  {
    id: "legal-drafter",
    name: "Legal Drafter",
    title: "Contract Review & Redline",
  },
  {
    id: "legal-researcher",
    name: "Legal Researcher",
    title: "Yurisprudensi & Regulasi",
  },
  {
    id: "compliance-officer",
    name: "Compliance Officer",
    title: "Perizinan & Due Diligence",
  },
];

export default function Home() {
  const { data: session } = useSession();
  const [selected, setSelected] = useState(legalCoworkers[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function startConsultation() {
    setBusy(true);
    setError("");
    try {
      const { channel } = await api<{ channel: Conversation }>("/api/channels", {
        method: "POST",
        body: { agentIds: [selected] },
      });
      router.push({
        pathname: "/conversation",
        params: { channelId: channel.id, agentId: selected },
      });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Tidak dapat memulai konsultasi.",
      );
    } finally {
      setBusy(false);
    }
  }
  const coworker =
    legalCoworkers.find((item) => item.id === selected) ?? legalCoworkers[0];
  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
      <Text style={{ fontSize: 24, fontWeight: "600" }}>
        Halo, {session.user.name}
      </Text>
      <Text style={muted}>{serverUrl}</Text>
      {error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Coworker Legal</Text>
      <View style={{ gap: 12 }}>
        {legalCoworkers.map((item) => {
          const active = item.id === selected;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Pilih ${item.name}`}
              disabled={busy}
              onPress={() => setSelected(item.id)}
              style={{
                ...card,
                borderColor: active ? colors.link : colors.border,
                backgroundColor: active ? "#eff6ff" : undefined,
              }}
            >
              <Text
                style={{
                  fontSize: 17,
                  fontWeight: "600",
                  color: active ? colors.link : undefined,
                }}
              >
                {item.name}
              </Text>
              <Text style={muted}>{item.title}</Text>
            </Pressable>
          );
        })}
      </View>
      <Button
        disabled={busy}
        title={
          busy ? "Memulai konsultasi…" : `Mulai konsultasi dengan ${coworker.name}`
        }
        onPress={() => {
          void startConsultation();
        }}
      />
      <Link href="/approvals" style={{ fontSize: 18, color: colors.link }}>
        Questions and approvals
      </Link>
      <Link href="/bots" style={{ fontSize: 18, color: colors.link }}>
        Bots, routines and computers
      </Link>
      <Link href="/memory" style={{ fontSize: 18, color: colors.link }}>
        Memory
      </Link>
    </ScrollView>
  );
}
