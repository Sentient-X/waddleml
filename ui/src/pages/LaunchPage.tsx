import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Rocket } from "lucide-react";
import { Link } from "react-router-dom";
import { Button, Input, PageHeader } from "@sx/ui";

// The launch form posts to train serve (:8500, proxied at /train-api) — a
// different backend than the waddle API, so its request/response types are
// hand-written here rather than derived from this app's OpenAPI schema.
const METHODS = ["bc", "clap", "clap_tinker", "oft", "grpo"] as const;
const BACKENDS = ["local", "tinker"] as const;

interface CreatedJob {
  id: string;
  status: string;
  waddle_run_id: string;
}

interface LaunchForm {
  method: (typeof METHODS)[number];
  backend: (typeof BACKENDS)[number];
  config_path: string;
  dataset: string;
  task_id: string;
  schema_version: string;
  task_sha256: string;
  embodiment_name: string;
  embodiment_id: string;
  embodiment_manifest_sha256: string;
}

const INITIAL: LaunchForm = {
  method: "bc",
  backend: "local",
  config_path: "configs/pi0_libero_bc.py",
  dataset: "",
  task_id: "",
  schema_version: "0.2",
  task_sha256: "",
  embodiment_name: "",
  embodiment_id: "",
  embodiment_manifest_sha256: "",
};

async function createJob(form: LaunchForm): Promise<CreatedJob> {
  const response = await fetch("/train-api/v1/autonomy/training/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      method: form.method,
      backend: form.backend,
      config_path: form.config_path,
      dataset: form.dataset,
      task: {
        task_id: form.task_id,
        schema_version: form.schema_version,
        sha256: form.task_sha256,
      },
      embodiment_name: form.embodiment_name,
      embodiment: {
        embodiment_id: form.embodiment_id,
        manifest_sha256: form.embodiment_manifest_sha256,
      },
      metadata: {},
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const detail = (body as { detail?: unknown }).detail;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail ?? body));
  }
  return body as CreatedJob;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export function LaunchPage() {
  const [form, setForm] = useState<LaunchForm>(INITIAL);
  const launch = useMutation<CreatedJob, Error, LaunchForm>({ mutationFn: createJob });

  function set<K extends keyof LaunchForm>(key: K, value: LaunchForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const text = (key: keyof LaunchForm, placeholder: string, mono = true) => (
    <Input
      value={form[key]}
      onChange={(e) => set(key, e.target.value as LaunchForm[typeof key])}
      placeholder={placeholder}
      spellCheck={false}
      className={mono ? "font-mono text-xs" : undefined}
    />
  );

  const selectClass =
    "h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs";

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <PageHeader
        title="Launch"
        description="Create a training job on the Autonomy training service; the job tracks live as a run here."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Method">
          <select
            className={selectClass}
            value={form.method}
            onChange={(e) => set("method", e.target.value as LaunchForm["method"])}
          >
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Backend">
          <select
            className={selectClass}
            value={form.backend}
            onChange={(e) => set("backend", e.target.value as LaunchForm["backend"])}
          >
            {BACKENDS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Field>
        <Field label="Config path">{text("config_path", "configs/pi0_libero_bc.py")}</Field>
        <Field label="Dataset">{text("dataset", "datasets.libero-spatial")}</Field>
        <Field label="Task id">{text("task_id", "task_libero_spatial")}</Field>
        <Field label="Task schema version">{text("schema_version", "0.2")}</Field>
        <Field label="Task sha256">{text("task_sha256", "64 hex chars")}</Field>
        <Field label="Embodiment name">{text("embodiment_name", "embodiments.panda-omron")}</Field>
        <Field label="Embodiment id">{text("embodiment_id", "panda_omron")}</Field>
        <Field label="Embodiment manifest sha256">
          {text("embodiment_manifest_sha256", "64 hex chars")}
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => launch.mutate(form)}
          disabled={launch.isPending}
        >
          <Rocket className="h-4 w-4" /> {launch.isPending ? "Creating…" : "Create job"}
        </Button>
      </div>

      {launch.isError ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span className="text-destructive">{launch.error.message}</span>
        </div>
      ) : null}

      {launch.data ? (
        <div className="rounded-lg border bg-card px-3 py-2 text-sm">
          <p>
            Job <span className="font-mono text-xs">{launch.data.id}</span> is{" "}
            <span className="font-medium">{launch.data.status}</span>.
          </p>
          <p className="mt-1">
            <Link className="text-primary underline" to={`/runs/${launch.data.waddle_run_id}`}>
              View the live run →
            </Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}
