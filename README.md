This is the repository for the MMRF Data Commons.


## Getting Started
MMRF Data Commons using the Gen3 Frontend Framework is a matter of the following:

* create a clone of [Gen3 Data Commons Application](https://github.com/uc-cdis/commons-frontend-app/)  

* Configure the commons by editing the configuration files in the ```config```

* Add your pages and content

* Deploy via helm charts or Docker.

Changes to the Gen3 Data Commons Application can be pulled from the Common Frontend Repository. You need configure git to pull from the Common Frontend Repository.
```bash
git remote add upstream https://github.com/uc-cdis/commons-frontend-app.git
```
or
```bash
git remote add upstream git@github.com:uc-cdis/commons-frontend-app.git
```

changes to ```main``` can be pulled from the Common Frontend Repository by running:
```bash
git pull upstream main
```

Please see [Styling and Theming](https://github.com/uc-cdis/gen3-frontend-framework/blob/develop/docs/Local%20Development/Styling%20and%20Theming.md) and [Local Development with Helm Charts](https://github.com/uc-cdis/gen3-frontend-framework/blob/develop/docs/Local%20Development/Using%20Helm%20Charts/Local%20Development%20with%20Helm%20Charts.md)
for more information on setting up and configuring the Gen3 Data Commons Application.
This documentation is currently less complete than we would like, but we will be adding to it as development progresses.

## Installation

This project requires Node.js >=24.18.1 and npm >=11.16.0, as specified in
`package.json`. `.npmrc` enforces these requirements with `engine-strict=true`.
Using [nvm](https://github.com/nvm-sh/nvm), run these commands from the repository
root in your terminal (including the integrated terminal in Cursor):

```bash
nvm install
nvm use
node --version
npm --version
```

The Node version is read from `.nvmrc`. Run `nvm use` in each new terminal before
working on this project. If the selected Node installation has an older npm,
update npm after selecting Node:

```bash
npm install --global npm@11.16.0
```

An `EBADENGINE` error means the active Node or npm version does not satisfy these
requirements. Select the correct runtime instead of disabling engine checks.

### Install Dependencies

From the root of the project, install dependencies by running:

```bash
npm install
```

### Run the Development Server

The development server runs the frontend; it does not start the Gen3 backend
services. To use the hosted VLab development backend, create the git-ignored
`.env.development.local` file in the repository root with:

```dotenv
NEXT_PUBLIC_GEN3_API_TARGET=https://dev-virtuallab.themmrf.org
```

Keep `NEXT_PUBLIC_GEN3_API=http://localhost:3000` in `.env.development` so browser
requests go through the local development proxy. Restart the server after changing
environment variables. Without an API target, the proxy defaults to
`https://localhost`; if no backend is running there, it will fail with
`ECONNREFUSED` on port 443 and display a commons services error.

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.


## Docker

### Synthetic sandbox builds

Google Analytics and its tracking-consent modal are disabled for synthetic builds,
development/test builds, loopback hosts, and hosts other than the build-time
`NEXT_PUBLIC_GA_HOSTNAME`. The production configuration permits only
`virtuallab.themmrf.org`; consent and `NEXT_PUBLIC_GA_MEASUREMENT_ID` are still
required to load Google Analytics there. Keep that hostname restricted to the
production site when building dev/preview images. Essential application cookies
and local cohort storage continue to work without the tracking modal. These
`NEXT_PUBLIC_` settings require rebuilding the frontend image.

The standalone [Virtual Lab sandbox](https://github.com/theMMRF/mmrf-virtual-lab-sandbox)
provides generated data, a disposable local identity provider, and local/AWS
deployment configuration. Build with `NEXT_PUBLIC_SYNTHETIC_SANDBOX=1` to show a
synthetic-data notice, disable analytics, and prevent demo-mode URLs from loading
the historical demonstration fixtures. This flag does not bypass authentication;
the sandbox supplies its own isolated identity services. Leave the flag unset
for normal deployments.

You build a Docker image by:

```bash
docker build .
# Presentation flag only; use the standalone sandbox for generated data/services.
docker build --build-arg NEXT_PUBLIC_SYNTHETIC_SANDBOX=1 .
```

## ORION Assistant

ORION is an assistant for the synthetic sandbox. It turns a plain-language question into a
visible plan, runs the site's own tools, shows the results with every number cited, and asks
before saving cohorts. It opens from **Assistant** in the top navigation (`/?app=Assistant`).
The UI is in `src/features/orion` and the BFF routes are in `src/pages/api/orion`. It needs the
ORION agent, which lives in the sandbox repository: see
[ORION_QUICKSTART.md](https://github.com/kaizzzed/mmrf-virtual-lab-sandbox/blob/main/ORION_QUICKSTART.md)
to run both. Run its tests with:

```bash
NODE_OPTIONS=--no-experimental-strip-types npx jest src/features/orion src/pages/api/orion
```

## CI and deployment

AWS CodePipeline and CodeBuild handle the deployment image build and storage in
Amazon ECR. GitHub Actions runs lint and Storybook interaction/accessibility
checks when a pull request is opened, updated, or reopened. It does not publish
container images. New commits to the same PR cancel superseded check runs.

The inherited CTDS image-publishing workflow and its bundled security job have
been removed. GitHub Actions does not need Quay or AWS publishing credentials for
the retained PR checks. Existing repository secrets are not deleted by this
change; check their use by other systems before removing them.

## Updating a forked commons

The following steps usually apply to update a forked commons.

Get the changes from the parent fork:
```bash
git remote add upstream git@github.com:uc-cdis/commons-frontend-app.git
git fetch upstream
```
Create a branch and merge changes from upstream:
```bash
git merge upstream/main
```
If the above has the error message:  "fatal: refusing to merge unrelated histories" error.
This often happens when the repo was created as a template, not a fork.
To resolve this, the ```--allow-unrelated-histories``` flag can be used during the merge operation. This flag forces Git to merge the branches despite lacking a common history.
```bash
git merge upstream/main --allow-unrelated-histories
```
If you use this flag, it is recommended that you carefully review the changes and resolve any conflicts before finalizing the merge.

You will see merge conflicts. In general: **take the remote's version for everything except the config files**, as those are customized to the commons config. Resolve any remaining config issues and open a PR.
Test the new common by running it locally or in a staging environment.
