# Training server setup

A training server runs the production build of Flight System, with every rule enforced, on a separate
training database. Every page, print and download shows **TRAINING, NOT THE RECORD**. Paper stays the
record. Nothing entered here is a quality record.

You need Node.js 22 LTS (22.13 or later) and a copy of this repository or the release zip. In that folder, run
`npm ci --omit=dev` once.

## A. On my laptop (small rehearsal, a few people)

1. Start the server and leave the window open:

   ```bash
   node server/server.mjs --training --host 0.0.0.0 --port 8080 --db training.sqlite
   ```

   `--host 0.0.0.0` lets other computers on the same network reach it. Leave it out to use the server
   only on your own laptop. `training.sqlite` is created next to where you run the command. Never point
   `--db` at a real Flight System database.
2. Find your address. On a Mac run `ipconfig getifaddr en0`; on Windows run `ipconfig` and read the IPv4
   Address. Everyone opens `http://<that address>:8080` in Chrome or Edge.
3. Firewall: the first start asks whether Node may accept incoming connections. Allow it on private
   networks only. If nobody can connect, allow port 8080 for Node in the firewall settings.
4. Keep the laptop awake and plugged in: on a Mac, run `caffeinate -dis` in a second window; on Windows,
   set sleep to Never while plugged in. A sleeping laptop stops the session for everyone.
5. Plain HTTP: passwords, sign-in sessions and everything on screen cross the network unencrypted, so
   anyone on that network could read them or take over a session. Use it only on a trusted office network,
   and give everyone a training password they use nowhere else. Until the first account exists, anyone who
   can reach the address sees the setup screen: the setup code in your window is the only thing that
   protects it, so keep that window to yourself and create your account right away.
6. Back up the database at the end of each session (it works while the server runs). A backup holds the
   accounts and password hashes: keep it with the training database, never in a production location.

   ```bash
   node server/server.mjs --db training.sqlite --backup training-backup-2026-10-02.sqlite
   ```

## B. IT machine (the 20-person floor demo)

- An always-on machine or VM (2 CPUs, 4 GB memory, 20 GB disk is plenty) with Node.js 22 LTS.
- A fixed name, for example `flight-training.<company domain>`, so nobody types an IP address.
- Run the server as a service that restarts on failure, started in the application folder and bound to the
  machine itself:
  `node server/server.mjs --training --port 8080 --db data/training.sqlite`
  (or set `FLIGHT_TRAINING=1` in the service instead of `--training`; any value other than 1, true, yes, on,
  0, false, no or off stops the server rather than starting it unmarked).
- An HTTPS reverse proxy (nginx, IIS or the company load balancer) in front of it, forwarding to
  `127.0.0.1:8080`, with the request size limit at 100 MB (`client_max_body_size 100m;` in nginx).
- A nightly backup with the `--backup` command above, keeping at least 7 copies.

## First run (both setups)

1. When the server starts with no accounts, its window prints `First-run setup code: <code>`. Copy it.
2. Open the address. On the **Set up Master Access** screen, enter your name, username, a password and the
   setup code. That first account is yours, with Master Access. The code is not needed again.
3. A second QA Manager is needed because nobody records their own training or issues their own stamp.
   In **Your credentials**, use **Record a training** to record ESD (or another active training) for the
   person, then **Add an account** with the QA Manager role, citing that training.
4. Accounts for everyone: add each person with their role (Technician, Operations, Manufacturing
   Engineering, Engineering, Quality, Certification). Roles that inspect or hold an MRB seat (Quality,
   Manufacturing Engineering, Engineering, Certification, QA Manager) need a current training record
   first, so record the training, then add the account.
5. Stamps and training: the **second QA Manager** signs in on their own computer, records your training and
   uses **Issue a stamp** for each technician, each inspector and you. Each holder then sets their own
   **Stamp PIN** in Your credentials before their first buy-off.
6. Sample data from `samples/training/` (see its README): a QA Manager imports `calibration.csv`; an
   engineer imports `master_wis.csv`; a different engineer peer reviews each WI and Quality releases it;
   then `work_orders.csv` is imported on **All work orders**.
7. Print a test traveler: open a work order, choose **Print traveler**, and check that TRAINING, NOT THE
   RECORD is at the top of the page. Every file the training server lets you save is named `TRAINING-...`.

## Good to know on the day

- One computer per person. Signing in somewhere else ends the first session.
- Other people's changes appear when you refresh the page. If a message says the shared workspace changed
  on another device, the page has already reloaded: do the step again.
- Sessions end after 30 minutes without activity; sign in again.

## Request to IT (paste as is)

> Please provide an always-on Linux or Windows VM for a one-day Flight System training session for about
> 20 people on the shop floor network: Node.js 22 LTS, 2 CPUs, 4 GB memory, 20 GB disk, a fixed internal
> DNS name (for example flight-training.<our domain>) with an internal HTTPS certificate, and a reverse proxy
> forwarding to 127.0.0.1:8080 with a 100 MB request limit. The application runs as a service with
> `node server/server.mjs --training --port 8080 --db data/training.sqlite`, stores its
> data in that one SQLite file, makes no outbound internet connections and needs no other database. Please
> back up that file nightly and allow access only from the internal network. It holds training data only,
> not quality records.
