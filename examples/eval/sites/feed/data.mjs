// Seeded synthetic social feed ("Driftnote"): text and video posts across a
// few topics. Deterministic per seed; bodies are long enough that a summary
// cannot pass the verbatim check.
import { rng, pick } from '../../lib/common.mjs'

export const TOPICS = ['trail running', 'sourdough', 'film cameras', 'balcony garden']
const AUTHORS = ['mira.walks', 'olek_bakes', 'tamsin.frames', 'juno_grows', 'pax.outdoors', 'ines.kitchen', 'rafa.lens', 'lotte.leaf', 'bo.trails', 'nadia.crumb', 'kit.shutter', 'ember.soil']
const OPENERS = {
  'trail running': ['Ran the ridge loop before sunrise', 'First time on technical descents', 'What I carry on a 30 km trail day', 'Recovering from a rolled ankle', 'Night running with a headlamp', 'Hill repeats that actually helped', 'Choosing shoes for wet rock', 'Pacing a long climb without burning out', 'My mistakes on a first ultra', 'Trail etiquette I learned the hard way'],
  sourdough: ['Reviving a neglected starter', 'Higher hydration, better crumb?', 'Cold retard schedule that fits a workday', 'Why my loaves spread flat', 'Rye starter versus wheat starter', 'Scoring patterns for beginners', 'Baking in a cast iron pot', 'Feeding ratios I settled on', 'Whole wheat without a brick', 'Proofing in a chilly kitchen'],
  'film cameras': ['Loading my first medium format roll', 'Metering without a working meter', 'Push processing a dim roll', 'Cleaning fungus from an old lens', 'Choosing between two 35 mm stocks', 'Scanning negatives at home', 'Light leaks and how I found mine', 'Zone focusing on the street', 'A cheap point and shoot that surprised me', 'Storing film in summer heat'],
  'balcony garden': ['Tomatoes in a north-facing balcony', 'Self-watering pots from buckets', 'Herbs that survived the winter', 'Dealing with aphids without spray', 'Wind protection on a high floor', 'Compost in a small apartment', 'Strawberries in hanging planters', 'Seed starting on a windowsill', 'Choosing soil for containers', 'Mint took over everything']
}
const SENTENCES = [
  'I wrote down every step this time so I could compare it with last month.', 'The biggest change came from slowing down rather than adding anything new.',
  'A friend suggested a small tweak and it made more difference than the expensive gear.', 'I kept the notes on my phone and checked them each evening.',
  'The first attempt went badly, which taught me more than the second one.', 'Weather mattered more than I expected, so I planned around it.',
  'I measured everything twice because my first numbers looked wrong.', 'Most advice online assumes much more time than I actually have.',
  'After two weeks the routine felt natural instead of forced.', 'I would skip the fancy accessories and spend on basics instead.',
  'The result was not perfect, but it was repeatable, which is what I wanted.', 'Next time I will start earlier and give it more patience.',
  'Several comments asked for details, so here is the full process.', 'I tracked the results in a simple table and the pattern was obvious.',
  'It took three tries before anything worked the way the guides promised.', 'The cheapest option turned out to be the most reliable one.'
]

const cache = new Map()
export function feedData(seed) {
  if (cache.has(seed)) return cache.get(seed)
  const r = rng('feed:' + seed), posts = []
  for (const topic of TOPICS) {
    const openers = [...OPENERS[topic]].sort(() => r() - 0.5)
    openers.forEach((title, i) => {
      // Roughly one in three posts is a video with a short caption only.
      const video = i % 3 === 1
      const body = video ? `${title}. Full walkthrough in the video, captions on.` : Array.from({ length: 5 + Math.floor(r() * 3) }, () => pick(r, SENTENCES)).join(' ') + ` #${topic.replace(/ /g, '')}`
      posts.push({ id: `p${String(posts.length + 1).padStart(3, '0')}${seed[0]}`, topic, title, author: pick(r, AUTHORS), video, body,
        date: `2026-0${1 + Math.floor(r() * 9)}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`, likes: Math.floor(r() * 4000),
        comments: Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ author: pick(r, AUTHORS), text: pick(r, ['So useful, saving this!', 'Which brand did you use?', 'Tried it and it worked for me too.', 'Could you share more photos?', 'This is exactly my problem.']) })) })
    })
  }
  // Interleave topics so a search result mixes text and video in feed order.
  const shuffled = posts.map(p => ({ p, k: r() })).sort((a, b) => a.k - b.k).map(x => x.p)
  const data = { posts: shuffled }
  cache.set(seed, data)
  return data
}
export const searchPosts = (seed, q) => feedData(seed).posts.filter(p => !q || p.topic.includes(String(q).toLowerCase().trim()) || p.title.toLowerCase().includes(String(q).toLowerCase().trim()))
