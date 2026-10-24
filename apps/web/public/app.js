// Kavvo web shell UI — vanilla JS, no build step.
// Talks only to the shell's own /api endpoints.

const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    throw new Error(
      (data && data.error) || `${method} ${path} failed (${response.status})`,
    );
  }
  return data;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

/* ---------------- health ---------------- */

async function checkHealth() {
  const dot = $("health-dot");
  const text = $("health-text");
  try {
    const data = await api("GET", "/api/health");
    dot.className = "health-dot " + (data.ok ? "ok" : "down");
    text.textContent = data.ok ? "server online" : "server unhealthy";
  } catch {
    dot.className = "health-dot down";
    text.textContent = "server unreachable";
  }
}

/* ---------------- skills ---------------- */

let selectedSkill = null;
let knownSkills = [];

function inputTemplate(skill) {
  const schema = skill.inputSchema || {};
  const properties = schema.properties || {};
  const template = {};
  for (const [field, spec] of Object.entries(properties)) {
    if (spec && spec.type === "number") template[field] = 0;
    else if (spec && spec.type === "boolean") template[field] = false;
    else if (spec && spec.type === "array") template[field] = [];
    else if (spec && spec.type === "object") template[field] = {};
    else template[field] = "";
  }
  return template;
}

function selectSkill(skill, element) {
  selectedSkill = skill;
  document
    .querySelectorAll(".skill-list li")
    .forEach((li) => li.classList.remove("selected"));
  if (element) element.classList.add("selected");
  $("selected-skill-name").textContent = `${skill.name} — ${skill.id}`;
  $("selected-skill-desc").textContent = skill.description;
  $("skill-input").value = pretty(inputTemplate(skill));
  $("skill-status").textContent = "";
  $("skill-status").className = "status-line";
}

async function loadSkills() {
  const list = $("skill-list");
  list.textContent = "";
  const skills = await api("GET", "/api/skills");
  knownSkills = skills;
  for (const skill of skills) {
    const li = document.createElement("li");
    const id = document.createElement("span");
    id.className = "skill-id";
    id.textContent = skill.id;
    const name = document.createElement("span");
    name.className = "skill-name";
    name.textContent = skill.name;
    li.append(id, name);
    li.title = skill.description;
    li.addEventListener("click", () => selectSkill(skill, li));
    list.appendChild(li);
    if (!selectedSkill) selectSkill(skill, li);
  }
  // The automation form picks from the same registry — forged skills
  // included, since they share it.
  const select = $("auto-skill");
  if (select) {
    const current = select.value;
    select.textContent = "";
    for (const skill of skills) {
      const option = document.createElement("option");
      option.value = skill.id;
      option.textContent = skill.id;
      select.appendChild(option);
    }
    if (skills.some((s) => s.id === current)) select.value = current;
  }
}

async function refreshSkills() {
  selectedSkill = null;
  await loadSkills();
}

async function runSelectedSkill() {
  const status = $("skill-status");
  const output = $("skill-result");
  status.className = "status-line";
  if (!selectedSkill) {
    status.textContent = "Pick a skill first.";
    return;
  }
  let input;
  try {
    input = JSON.parse($("skill-input").value);
  } catch (err) {
    status.textContent = `Input is not valid JSON: ${err.message}`;
    status.classList.add("error");
    return;
  }
  status.textContent = "running…";
  try {
    const data = await api(
      "POST",
      `/api/skills/${encodeURIComponent(selectedSkill.id)}/run`,
      input,
    );
    output.textContent = pretty(data.result);
    status.textContent = "done";
  } catch (err) {
    output.textContent = "—";
    status.textContent = err.message;
    status.classList.add("error");
  }
}

/* ---------------- jobs ---------------- */

const SAMPLE_JOB = {
  title: "Slug a title, then count the slug",
  steps: [
    {
      id: "make-slug",
      kind: "skill",
      skillId: "text.slugify",
      input: { title: "Hello Kavvo World" },
    },
    {
      id: "count",
      kind: "skill",
      skillId: "text.word-count",
      input: { text: "{{make-slug.slug}}" },
    },
  ],
};

let currentJobId = null;
let pollTimer = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderJob(job) {
  currentJobId = job.id;
  $("job-detail").hidden = false;
  $("job-title").textContent = job.title ? `${job.title} (${job.id})` : job.id;
  const chip = $("job-chip");
  chip.textContent = job.status;
  chip.className = `chip ${job.status}`;
  $("job-meta").textContent =
    `created ${job.createdAt} · updated ${job.updatedAt}`;
  const errorBox = $("job-error");
  if (job.error) {
    errorBox.hidden = false;
    errorBox.textContent = job.error;
  } else {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  $("resume-job").disabled = !(
    job.status === "failed" || job.status === "paused"
  );

  const list = $("step-list");
  list.textContent = "";
  const defs = new Map((job.definition.steps || []).map((s) => [s.id, s]));
  for (const step of job.steps) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "step-head";
    const id = document.createElement("span");
    id.className = "step-id";
    id.textContent = step.id;
    const kind = document.createElement("span");
    kind.className = "step-kind";
    const def = defs.get(step.id);
    kind.textContent =
      step.kind === "skill" && def ? `skill: ${def.skillId}` : step.kind;
    const chipEl = document.createElement("span");
    chipEl.className = `chip ${step.status}`;
    chipEl.textContent = step.status;
    head.append(id, kind, chipEl);
    li.appendChild(head);
    if (step.status === "completed" && step.output !== undefined) {
      const pre = document.createElement("pre");
      pre.textContent = pretty(step.output);
      li.appendChild(pre);
    }
    if (step.status === "failed" && step.error) {
      const err = document.createElement("div");
      err.className = "step-error";
      err.textContent = step.error;
      li.appendChild(err);
    }
    list.appendChild(li);
  }

  stopPolling();
  if (job.status === "pending" || job.status === "running") {
    pollTimer = setInterval(() => loadJob(job.id).catch(() => {}), 1000);
  }
}

async function loadJob(jobId) {
  const job = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
  renderJob(job);
  return job;
}

async function refreshJobList() {
  const list = $("job-list");
  list.textContent = "";
  const jobs = await api("GET", "/api/jobs");
  for (const job of jobs) {
    const li = document.createElement("li");
    const id = document.createElement("span");
    id.className = "job-id";
    id.textContent = job.id;
    const label = document.createElement("span");
    label.textContent = ` — ${job.status}${job.title ? ` · ${job.title}` : ""}`;
    li.append(id, label);
    li.addEventListener("click", () => {
      loadJob(job.id).catch((err) => {
        $("job-status").textContent = err.message;
        $("job-status").classList.add("error");
      });
    });
    list.appendChild(li);
  }
}

async function runJobFromEditor() {
  const status = $("job-status");
  status.className = "status-line";
  let definition;
  try {
    definition = JSON.parse($("job-input").value);
  } catch (err) {
    status.textContent = `Job definition is not valid JSON: ${err.message}`;
    status.classList.add("error");
    return;
  }
  status.textContent = "running…";
  try {
    const job = await api("POST", "/api/jobs", definition);
    renderJob(job);
    status.textContent = `job ${job.status}`;
    if (job.status === "failed") status.classList.add("error");
    refreshJobList().catch(() => {});
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
  }
}

async function resumeCurrentJob() {
  if (!currentJobId) return;
  const status = $("job-status");
  status.className = "status-line";
  status.textContent = "resuming…";
  try {
    const job = await api(
      "POST",
      `/api/jobs/${encodeURIComponent(currentJobId)}/resume`,
    );
    renderJob(job);
    status.textContent = `job ${job.status}`;
    if (job.status === "failed") status.classList.add("error");
    refreshJobList().catch(() => {});
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
  }
}

/* ---------------- memory ---------------- */

function setStatus(id, message, isError) {
  const el = $(id);
  el.textContent = message;
  el.className = "status-line" + (isError ? " error" : "");
}

async function loadMemory() {
  const list = $("memory-list");
  list.textContent = "";
  const items = await api("GET", "/api/memory");
  const recent = [...items]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 12);
  if (recent.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Nothing remembered yet.";
    list.appendChild(li);
    return;
  }
  for (const item of recent) {
    const li = document.createElement("li");
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = item.kind;
    const text = document.createElement("span");
    text.className = "grow";
    text.textContent =
      item.text +
      (item.tags && item.tags.length ? `  ·  ${item.tags.join(", ")}` : "");
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "secondary mini";
    forget.textContent = "forget";
    forget.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/memory/${encodeURIComponent(item.id)}`);
        setStatus("memory-status", "forgotten");
        loadMemory().catch(() => {});
      } catch (err) {
        setStatus("memory-status", err.message, true);
      }
    });
    li.append(chip, text, forget);
    list.appendChild(li);
  }
}

async function addMemory() {
  const text = $("memory-text").value.trim();
  if (!text) {
    setStatus("memory-status", "Write the memory first.", true);
    return;
  }
  const tags = $("memory-tags")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const importance = Number($("memory-importance").value) || 3;
  try {
    const item = await api("POST", "/api/memory", {
      kind: $("memory-kind").value,
      text,
      tags,
      importance,
    });
    setStatus("memory-status", `remembered (${item.kind}, importance ${item.importance})`);
    $("memory-text").value = "";
    $("memory-tags").value = "";
    loadMemory().catch(() => {});
  } catch (err) {
    setStatus("memory-status", err.message, true);
  }
}

async function loadMemoryContext() {
  const query = $("memory-query").value.trim();
  const budget = Number($("memory-budget").value) || 200;
  try {
    const data = await api(
      "GET",
      `/api/memory/context?q=${encodeURIComponent(query)}&budget=${budget}`,
    );
    $("memory-context").textContent = data.context || "—";
    $("memory-context-meta").textContent =
      `≈ ${data.estimatedTokens} estimated tokens (budget ${budget})`;
  } catch (err) {
    setStatus("memory-status", err.message, true);
  }
}

/* ---------------- automations ---------------- */

function triggerSummary(trigger) {
  if (!trigger) return "—";
  if (trigger.type === "daily") return `daily at ${trigger.at}`;
  if (trigger.type === "interval") return `every ${trigger.everyMinutes} min`;
  if (trigger.type === "once") return `once at ${trigger.at}`;
  return trigger.type;
}

async function loadAutomations() {
  const list = $("automation-list");
  list.textContent = "";
  const schedules = await api("GET", "/api/automations");
  if (schedules.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No schedules yet — add a daily job below.";
    list.appendChild(li);
    return;
  }
  for (const schedule of schedules) {
    const li = document.createElement("li");
    const main = document.createElement("span");
    main.className = "grow";
    const name = document.createElement("strong");
    name.textContent = schedule.name;
    const meta = document.createElement("div");
    meta.className = "job-meta";
    meta.textContent =
      `${triggerSummary(schedule.trigger)} · next due ${schedule.nextDueAt ?? "—"}` +
      (schedule.lastStatus
        ? ` · last: ${schedule.lastStatus}${schedule.lastResult ? ` — ${schedule.lastResult}` : ""}`
        : "");
    main.append(name, meta);
    const chip = document.createElement("span");
    chip.className = "chip" + (schedule.enabled ? " completed" : "");
    chip.textContent = schedule.enabled ? "enabled" : "disabled";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary mini";
    toggle.textContent = schedule.enabled ? "disable" : "enable";
    toggle.addEventListener("click", async () => {
      try {
        await api(
          "POST",
          `/api/automations/${encodeURIComponent(schedule.id)}/${schedule.enabled ? "disable" : "enable"}`,
        );
        loadAutomations().catch(() => {});
      } catch (err) {
        setStatus("automation-status", err.message, true);
      }
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary mini";
    del.textContent = "delete";
    del.addEventListener("click", async () => {
      try {
        await api(
          "DELETE",
          `/api/automations/${encodeURIComponent(schedule.id)}`,
        );
        setStatus("automation-status", `deleted "${schedule.name}"`);
        loadAutomations().catch(() => {});
      } catch (err) {
        setStatus("automation-status", err.message, true);
      }
    });
    li.append(main, chip, toggle, del);
    list.appendChild(li);
  }
}

async function addAutomation() {
  const name = $("auto-name").value.trim();
  const at = $("auto-time").value || "09:00";
  const skillId = $("auto-skill").value;
  if (!name) {
    setStatus("automation-status", "Give the job a name first.", true);
    return;
  }
  if (!skillId) {
    setStatus("automation-status", "Pick a skill first.", true);
    return;
  }
  let input;
  try {
    input = JSON.parse($("auto-input").value);
  } catch (err) {
    setStatus("automation-status", `Skill input is not valid JSON: ${err.message}`, true);
    return;
  }
  try {
    const schedule = await api("POST", "/api/automations", {
      name,
      trigger: { type: "daily", at },
      job: {
        title: name,
        steps: [{ kind: "skill", skillId, input }],
      },
    });
    setStatus(
      "automation-status",
      `scheduled "${schedule.name}" — next due ${schedule.nextDueAt ?? "—"}`,
    );
    $("auto-name").value = "";
    loadAutomations().catch(() => {});
  } catch (err) {
    setStatus("automation-status", err.message, true);
  }
}

/* ---------------- forge ---------------- */

const SAMPLE_FORGE = {
  spec: {
    id: "text.shout",
    name: "Shout",
    description: "Uppercases the input text and adds a trailing exclamation mark.",
    input: { required: ["text"], properties: { text: "string" } },
    source:
      'const text = typeof input.text === "string" ? input.text : "";\nreturn { text: text.toUpperCase() + "!" };',
  },
  samples: [{ input: { text: "hello" }, expect: { text: "HELLO!" } }],
};

async function loadForge() {
  const list = $("forge-list");
  list.textContent = "";
  const records = await api("GET", "/api/forge");
  if (records.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No forged skills yet — forge one below.";
    list.appendChild(li);
    return;
  }
  for (const record of records) {
    const li = document.createElement("li");
    const main = document.createElement("span");
    main.className = "grow";
    const id = document.createElement("span");
    id.className = "skill-id";
    id.textContent = record.id;
    const meta = document.createElement("div");
    meta.className = "job-meta";
    meta.textContent =
      `forged ${record.forgedAt} · spec ${String(record.specHash).slice(0, 10)}…`;
    main.append(id, meta);
    const unforgeBtn = document.createElement("button");
    unforgeBtn.type = "button";
    unforgeBtn.className = "secondary mini";
    unforgeBtn.textContent = "unforge";
    unforgeBtn.addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/forge/${encodeURIComponent(record.id)}`);
        setStatus("forge-status", `unforged ${record.id}`);
        loadForge().catch(() => {});
        refreshSkills().catch(() => {});
      } catch (err) {
        setStatus("forge-status", err.message, true);
      }
    });
    li.append(main, unforgeBtn);
    list.appendChild(li);
  }
}

async function forgeFromEditor() {
  let parsed;
  try {
    parsed = JSON.parse($("forge-spec").value);
  } catch (err) {
    setStatus("forge-status", `Spec is not valid JSON: ${err.message}`, true);
    return;
  }
  const body = parsed && parsed.spec ? parsed : { spec: parsed };
  try {
    const response = await fetch("/api/forge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) {
      const stage = data && data.stage ? ` [stage: ${data.stage}]` : "";
      throw new Error(`${(data && data.error) || "forge failed"}${stage}`);
    }
    setStatus("forge-status", `forged ${data.skill.id} — it is live in the Skills panel`);
    loadForge().catch(() => {});
    refreshSkills().catch(() => {});
  } catch (err) {
    setStatus("forge-status", err.message, true);
  }
}

/* ---------------- wiring ---------------- */

$("run-skill").addEventListener("click", runSelectedSkill);
$("run-job").addEventListener("click", runJobFromEditor);
$("resume-job").addEventListener("click", resumeCurrentJob);
$("refresh-jobs").addEventListener("click", () => {
  refreshJobList().catch((err) => {
    $("job-status").textContent = err.message;
    $("job-status").classList.add("error");
  });
});
$("load-job").addEventListener("click", () => {
  const jobId = $("job-id-input").value.trim();
  if (!jobId) return;
  loadJob(jobId).catch((err) => {
    $("job-status").textContent = err.message;
    $("job-status").classList.add("error");
  });
});

$("job-input").value = pretty(SAMPLE_JOB);
$("forge-spec").value = pretty(SAMPLE_FORGE);
$("auto-skill").addEventListener("change", () => {
  const skill = knownSkills.find((s) => s.id === $("auto-skill").value);
  if (skill) $("auto-input").value = pretty(inputTemplate(skill));
});

$("add-memory").addEventListener("click", addMemory);
$("refresh-memory").addEventListener("click", () => {
  loadMemory().catch((err) => setStatus("memory-status", err.message, true));
});
$("memory-context-btn").addEventListener("click", loadMemoryContext);
$("add-automation").addEventListener("click", addAutomation);
$("refresh-automations").addEventListener("click", () => {
  loadAutomations().catch((err) =>
    setStatus("automation-status", err.message, true),
  );
});
$("forge-btn").addEventListener("click", forgeFromEditor);
$("refresh-forge").addEventListener("click", () => {
  loadForge().catch((err) => setStatus("forge-status", err.message, true));
});

checkHealth();
loadSkills().catch((err) => {
  $("skill-status").textContent = err.message;
  $("skill-status").classList.add("error");
});
refreshJobList().catch(() => {});
loadMemory().catch(() => {});
loadAutomations().catch(() => {});
loadForge().catch(() => {});
