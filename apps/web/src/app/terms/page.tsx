import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import { SOCIAL_LINKS } from "@/site/social";

export const metadata: Metadata = {
	title: "Terms of Service - Cutlyra",
	description:
		"Terms for Cutlyra, a free and open-source local-first video editor.",
	openGraph: {
		title: "Terms of Service - Cutlyra",
		description:
			"Terms for Cutlyra, a free and open-source local-first video editor.",
		type: "website",
	},
};

export default function TermsPage() {
	return (
		<BasePage
			title="Cutlyra terms of service"
			description="Terms for using Cutlyra, a free and open-source local-first video editor."
		>
			<Accordion type="single" collapsible className="w-full">
				<AccordionItem
					value="quick-summary"
					className="rounded-2xl border px-5"
				>
					<AccordionTrigger className="no-underline!">
						Quick summary
					</AccordionTrigger>
					<AccordionContent>
						<h3 className="mb-3 text-lg font-medium">
							You own the content you create.
						</h3>
						<ol className="list-decimal space-y-2 pl-6">
							<li>Core Android editing, captions, and export run locally on your device.</li>
							<li>Cutlyra does not claim ownership of your videos or projects.</li>
							<li>There is no Cutlyra account, subscription, advertising, telemetry, or watermark.</li>
							<li>You are responsible for having the rights to media you import and for using Cutlyra lawfully.</li>
							<li>Cutlyra is provided on an &quot;as is&quot; basis without warranties to the extent permitted by law.</li>
							<li>The software is open source; the repository and license are available on GitHub.</li>
						</ol>
					</AccordionContent>
				</AccordionItem>
			</Accordion>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Your content and rights</h2>
				<p>
					<strong>You retain your rights in the content you create.</strong>{" "}
					Cutlyra does not claim ownership of your videos, projects, imported
					media, captions, or exported results.
				</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>Imported working media and project data are processed locally by the app.</li>
					<li>You are responsible for having permission to use imported media.</li>
					<li>Cutlyra does not add a watermark or impose a license on your exported videos.</li>
				</ul>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Using Cutlyra</h2>
				<p>You may use Cutlyra for lawful personal, educational, or commercial editing.</p>
				<p>
					The Cutlyra source code is licensed under the repository&apos;s open-source
					licenses. Those software licenses govern copying, modification, and
					distribution of the software itself; these terms do not replace them.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">On-device captions</h2>
				<p>
					On supported Android builds, automatic captions use a bundled
					whisper.cpp runtime and model locally on the device. Cutlyra does not
					upload your media to a captioning service.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Local storage and backups</h2>
				<p>
					Cutlyra stores projects and working media locally. Android cloud backup is
					disabled for Cutlyra&apos;s app data. Removing the app, clearing its data,
					deleting a project, device failure, or other local-storage loss may make
					projects unrecoverable. Keep copies of important source media and exported
					results.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Availability and compatibility</h2>
				<p>
					Cutlyra is provided &quot;as is&quot;. Device codecs, GPU/driver behavior,
					Android versions, storage availability, and media formats can affect
					editing or export compatibility. No guarantee of uninterrupted or
					error-free operation is made.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Limitation of liability</h2>
				<p>
					To the maximum extent permitted by applicable law, the Cutlyra
					contributors and publisher are not liable for indirect, incidental,
					special, consequential, or data-loss damages arising from use of the
					software. Nothing here excludes liability that cannot legally be excluded.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Changes</h2>
				<p>
					These terms may be updated as Cutlyra changes. The current version is
					published with the project. Material release changes are documented in
					the repository changelog.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">Contact</h2>
				<p>
					For product or terms questions, use the{" "}
					<a
						href={`${SOCIAL_LINKS.github}/issues`}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						Cutlyra GitHub issue tracker
					</a>
					. The verified developer/support contact published with an official
					release is also an authorized contact channel.
				</p>
			</section>

			<Separator />
			<p className="text-muted-foreground text-sm">
				Last updated: October 4, 2026
			</p>
		</BasePage>
	);
}
