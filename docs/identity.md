# Wallwright identity

The app was called **Forge** until 2026-08-24. This file records what it is
called now, what that name is made of, and the rules for using it, so the two
admin surfaces (the wall's edit bar and the control page) stay one tool rather
than drifting into two.

## The name

**Wallwright.** A wright is someone who builds: a playwright, a shipwright, a
cartwright. A wallwright builds walls.

That is the product. Everything else in this category pushes pixels onto a
display; the thing only this app does is let an administrator **author** the wall
while standing at it, against live dashboards, at real wall resolution, with no
config file and no site visit from whoever wrote the layout. The editor is the
product, so the editor names the product.

It also lands in a tradition the people who will run this already know:
[Lightwright](https://en.wikipedia.org/wiki/Lightwright) is the standard
lighting paperwork tool in theatre, and CodeWright was a code editor. Show
technicians read `-wright` as "the tool you build the thing with."

### Why not the obvious names

The obvious names are all taken, and taken specifically in this category, which
is the worst place to collide. Checked 2026-08-24:

| name          | why not                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forge**     | [Honeywell Forge](https://www.honeywellforge.ai/) is Honeywell's own enterprise performance management software line. The exhibit shows Honeywell dashboards, so the old name collided with the client's product brand inside the client's own building.                                                                                                                                                                                                 |
| **Mosaic**    | [Ross Video Mosaic](https://www.rossvideo.com/products/production-switchers/mosaic/) is multi-screen video processing, [Planar Mosaic](https://www.zones.com/site/statics/static_page.html?name=partner%2Fplanar%2Fmosaic-architectural-video-walls) is an architectural video wall line with its own layout software, and [Userful Mosaic](https://indizium.com/product/userful-mosaic-videowall/) is a video wall processor. Three direct competitors. |
| **Tessera**   | [Brompton Tessera](https://www.bromptontech.com/) is the dominant LED processor platform for LED video walls. An LED wall app called Tessera reads as a Brompton product.                                                                                                                                                                                                                                                                                |
| **Montage**   | [DisplayNote Montage](https://www.displaynote.com/screen-sharing) puts multiple sources on one meeting-room display. Same shelf. The word survives in this app as the domain term for a saved layout, which is the right place for it.                                                                                                                                                                                                                   |
| **Multiview** | The [generic industry term](https://bzbgear.com/blog/what-is-a-multiviewer-and-its-advantages-in-the-av-industry/) for this class of hardware. Cannot function as a mark, and invites comparison to appliances.                                                                                                                                                                                                                                          |

Runners-up that were clear but not chosen: **Polyptych** (many panels hinged
into one work, which is the data model exactly, at the cost of spelling it out
loud forever) and **Mullion** (architectural and AV-native, but in video wall
jargon a mullion is the seam between displays, the number everyone tries to
minimise).

## The mark

An authored montage: one hero panel, a tall sidebar, two along the bottom,
wearing the layout editor's own corner grips.

Deliberately **not** a 2x2 grid. Every video wall product on the market draws a
quad split, and a quad split is also the one layout this app exists to get away
from, since the whole point is that the montage is arranged rather than given.
The uneven proportions are what a real wall looks like once someone has worked
on it.

The grips are the signature. They say the wall is editable, not merely lit.

**Sizes.** The grips only appear at 128px and above; `build/icon.png` has them.
Below that the mark is the montage silhouette alone: at 20px, four white squares
read as dirt on the glass rather than as handles. The small mark lives as inline
SVG in `src/overlay.js` (`MARK`) and `src/control-page.js`.

`build/icon.png` is generated, never hand-edited: `npm run icon` runs
`src/dev/make-icon.js`, which writes the PNG byte by byte with no dependencies.
Change the geometry there.

## The wordmark

`WALLWRIGHT`, set in the monospace stack, uppercase, 600 weight, `0.16em`
letterspacing.

Mono and letterspaced so it reads as a nameplate on a piece of equipment rather
than as one more label competing with the hints beside it. It is always
horizontal, always next to the mark, and never restyled per surface: the wall's
edit bar and the control page use the same treatment at 12px and 15px
respectively.

## Type

Two faces, and the split carries meaning:

- **System sans** (`-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica,
Arial`) for anything a person wrote: labels, hints, prose, buttons.
- **Mono** (`ui-monospace, Menlo, Consolas`) for machine facts, and for the
  wordmark. Panel ids, URLs, rectangles, zoom levels, memory, uptime.

An administrator scanning the wall should be able to tell at a glance which
numbers came from the machine. That is why the panel readouts in the editor
(`.eread`) and the inspector heads are mono, and it is why the wordmark is too:
this is equipment, and it says so.

## Palette

Defined once in `src/overlay.html` `:root` and mirrored with the same token names
in `src/control-page.js`. Change both together.

| token              | value       | for                                                     |
| ------------------ | ----------- | ------------------------------------------------------- |
| `--accent`         | `#f04e23`   | Hyperquake Poppy: selection, the active thing, the mark |
| `--accent-rgb`     | `240,78,35` | the same, for `rgba()` over live pages                  |
| `--ground`         | `#0d1117`   | the wall behind everything, and the control page ground |
| `--surface`        | `#161b22`   | a card or a field                                       |
| `--surface-raised` | `#21262d`   | a button at rest                                        |
| `--text`           | `#e6edf3`   | primary text                                            |
| `--muted`          | `#8b949e`   | secondary text, field labels                            |
| `--line`           | `#30363d`   | borders, dividers                                       |
| `--line-bright`    | `#57606a`   | a border that has to be seen over a live page           |
| `--guide`          | `#00e5ff`   | snap guides and the rubber band, **editor only**        |
| `--reading`        | `#7ee787`   | a machine fact read back: the live rectangle            |
| `--warn`           | `#ffa198`   | destructive, but nothing is wrong yet                   |
| `--alarm`          | `#f85149`   | something is actually wrong                             |

Poppy is carried over from Hyperquake rather than invented, so the exhibit's tool
matches the studio that built it. The neutrals are a GitHub-dark-shaped ramp,
chosen because the app is chrome floating over other people's dashboards and has
no business competing with them for colour.

Cyan is reserved. It appears only while a drag is live, which is what makes a
snap guide readable the instant it lands.

## Where the identity is allowed to appear

**The editor's bar, and the control page. Nowhere else.**

Grid mode and active mode carry no branding at all. A visitor standing at the
wall should see the dashboards, not the thing hosting them; the app's job there
is to be invisible. The wordmark shows up exactly when an administrator is
working _with_ the app rather than _through_ it.

The same reasoning covers the Back button, which stays an unbranded dark pill:
it belongs to the page it is floating over, not to us.
