import type { Metadata } from "next";

import { Button, Card, CardBody } from "@/components/ui";

import { logoutAction } from "./actions";

export const metadata: Metadata = { title: "Log out" };

export default function LogoutPage() {
  return (
    <Card>
      <CardBody className="space-y-4 p-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Log out</h1>
        <p className="text-sm text-ink-muted">
          Your agents keep running. Logging out only ends this browser session.
        </p>
        <form action={logoutAction}>
          <Button type="submit" className="w-full">
            Log out
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
