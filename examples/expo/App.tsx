import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { StringsProvider, useStrings } from "lefine/react";
import { createStrings, type StringsProps } from "lefine/server"; // "server" = runs anywhere: no Node or React inside
import { useEffect, useState } from "react";
import { ActivityIndicator, Button, StyleSheet, Text, View } from "react-native";

const project = process.env.EXPO_PUBLIC_LEFINE_APP;
if (!project) throw new Error("Set EXPO_PUBLIC_LEFINE_APP to your app's id (app_...): see README.md.");
const locales = (process.env.EXPO_PUBLIC_LEFINE_LOCALES ?? "en,de").split(",");

// One per app. `storage` keeps the last manifest and language files on the device, so a cold start shows texts at
// once, even offline, and refreshes in the background. (MMKV: { get: async (k) => mmkv.getString(k) ?? null, set: async (k, v) => mmkv.set(k, v) }.)
const strings = createStrings({
  project,
  storage: { get: (k) => AsyncStorage.getItem(k), set: (k, v) => AsyncStorage.setItem(k, v) },
  // Only for another edge (the local dev stack); unset means https://cdn.lefine.ai.
  ...(process.env.EXPO_PUBLIC_LEFINE_CDN ? { cdn: process.env.EXPO_PUBLIC_LEFINE_CDN } : {}),
});

export default function App() {
  const [locale, setLocale] = useState(locales[0]!);
  const [props, setProps] = useState<StringsProps | null>(null);
  useEffect(() => {
    void strings.load(locale, ["example"]).then(setProps);
  }, [locale]);
  if (!props) return <ActivityIndicator style={styles.page} />;
  return (
    <StringsProvider {...props}>
      <Home locales={locales} onLocale={setLocale} />
      <StatusBar style="auto" />
    </StringsProvider>
  );
}

function Home({ locales, onLocale }: { locales: string[]; onLocale: (locale: string) => void }) {
  const t = useStrings("example");
  const [count, setCount] = useState(0);
  return (
    <View style={styles.page}>
      <Text style={styles.title}>{t("title")}</Text>
      <Text>{t("intro")}</Text>
      <Button title={t("button")} onPress={() => setCount((n) => n + 1)} />
      <Text>{t("clicks", { count })}</Text>
      <View style={styles.row}>
        {locales.map((l) => (
          <Button key={l} title={l} onPress={() => onLocale(l)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: "center", padding: 32, gap: 12 },
  title: { fontSize: 24, fontWeight: "600" },
  row: { flexDirection: "row", gap: 12 },
});
