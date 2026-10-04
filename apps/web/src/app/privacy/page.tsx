import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = {
	title: "Privacy Policy - Cutlyra",
	description: "How Cutlyra accesses and protects media and project data while editing entirely on-device.",
};

export default function PrivacyPage() {
	return (
		<BasePage title="Cutlyra privacy policy" description="Cutlyra is an offline-first video editor. Your editing media and project data stay on your device.">
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Data Cutlyra accesses</h2>
				<p>When you choose media, Cutlyra accesses only the photos, videos, or audio files you select through Android&apos;s system pickers. Selected media is copied into Cutlyra&apos;s app-private storage so editing, previews, captions, and export can work locally.</p>
				<p>If you choose camera capture, Cutlyra requests camera access for that user-initiated capture. Camera media is processed locally. Cutlyra does not request broad photo-library access and does not request microphone access in the current Android release.</p>
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Collection and sharing</h2>
				<p>Cutlyra does not transmit your projects, media, captions, usage activity, identifiers, contacts, location, or other personal data off your device. It contains no advertising SDK, analytics SDK, telemetry service, account system, or cloud sync.</p>
				<p>Cutlyra does not sell or share user data.</p>
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Storage, retention, and deletion</h2>
				<p>Projects and imported working media remain in local app storage until you delete the project or remove the app/data from Android settings. Android cloud backup is disabled for Cutlyra. Exported videos remain wherever you choose to save them and are under your control.</p>
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Accounts</h2>
				<p>Cutlyra does not provide user accounts or sign-in, so the Cutlyra developer does not hold server-side account data and there is no cloud account to delete.</p>
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">On-device captions</h2>
				<p>Automatic captions use Cutlyra&apos;s bundled whisper.cpp runtime and English model locally on supported Android devices. Audio/video is not uploaded to a speech-recognition service.</p>
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Third-party components</h2>
				<p>Cutlyra uses open-source libraries for its app shell, editing, media processing, and on-device captions. They are used locally by the app; Cutlyra does not integrate advertising, analytics, or tracking services.</p>
			</section>
			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Privacy inquiries</h2>
				<p>Use the verified developer/support email published in Cutlyra&apos;s Google Play listing or the Cutlyra issue tracker at github.com/Pavithran-R-A/Cutlyra/issues for privacy inquiries.</p>
			</section>
			<Separator />
			<p className="text-muted-foreground text-sm">Last updated: October 4, 2026</p>
		</BasePage>
	);
}
