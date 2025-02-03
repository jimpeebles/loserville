import admin from 'firebase-admin'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import minimist from 'minimist'
import slugify from 'slugify'
import axios from 'axios'

// Resolve __dirname in ESM.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Initialize Firebase Admin SDK using credentials from GOOGLE_APPLICATION_CREDENTIALS.
const serviceAccountPath = path.resolve(__dirname, './moglService.json')
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Service account file not found at ./moglService.json')
  process.exit(1)
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const firestore = admin.firestore()

// Parse command-line arguments.
const args = minimist(process.argv.slice(2))
const propertyId = args.propertyId
const baseOutputDir = args.output || './content'

if (!propertyId) {
  console.error('Usage: node fetchArticles.js --propertyId=abcdefg [--output=./content]')
  process.exit(1)
}

// Determine the current year and append it to the output directory.
const currentYear = new Date().getFullYear().toString()
const outputDir = path.join(baseOutputDir, currentYear)

// Directory for locally storing downloaded images.
const imagesDir = path.join('public', 'images', 'covers')
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true })
}

/**
 * Fetch articles from Firestore for a given propertyId.
 */
async function fetchArticles() {
  const snapshot = await firestore
    .collection('articles')
    .where('propertyId', '==', propertyId)
    .get()

  if (snapshot.empty) {
    console.log('No articles found for propertyId:', propertyId)
    return []
  }

  const articles = []
  snapshot.forEach((doc) => {
    const data = doc.data()
    // Use the Firestore document id if no explicit id is provided.
    data.id = data.id || doc.id
    articles.push(data)
  })
  return articles
}

/**
 * Build YAML frontmatter using the specified keys.
 */
function buildFrontmatter(article) {
  return {
    id: article.id || '',
    title: article.articleData.title || '',
    description: article.articleData.description || '',
    date: article.date || '',
    cover: article.articleData.cover || '',
    comments: article.articleData.comments !== undefined ? article.articleData.comments : false,
    listed: article.articleData.listed !== undefined ? article.articleData.listed : true,
    hidden: article.articleData.hidden !== undefined ? article.articleData.hidden : false,
    draft: article.articleData.draft !== undefined ? article.articleData.draft : false,
    table_of_contents: article.articleData.table_of_contents !== undefined ? article.articleData.table_of_contents : false,
    tags: article.articleData.tags || [],
    categories: article.articleData.categories || []
  }
}

/**
 * Download an image from a URL and save it locally.
 * Returns the local file path (relative to the project root).
 */
async function downloadImage(imageUrl, filename) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' })
    const localPath = path.join(imagesDir, filename)
    fs.writeFileSync(localPath, Buffer.from(response.data))
    return localPath
  } catch (error) {
    console.error('Error downloading image:', error)
    throw error
  }
}

/**
 * Main function: fetch articles and write them as Markdown files.
 * Each file will be saved to content/{currentYear}/{slug}.md,
 * and the cover property in the frontmatter will point to a local file
 * in assets/blog-images/{slug}-cover.jpg (or similar).
 */
async function main() {
  try {
    const articles = await fetchArticles()
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }
    for (const article of articles) {
      // article.articleData is assumed to hold the generated article properties.
      const articleData = article.articleData
      // Build frontmatter from articleData.
      let frontmatter = buildFrontmatter(article)
      
      // Determine slug: use article.slug if available, otherwise generate from title or id.
      const slugValue =
        article.slug ||
        slugify(articleData.title || article.id, { lower: true, strict: true })
      
      // Define the target markdown file path.
      const filePath = path.join(outputDir, `${slugValue}.md`)
      // If the file already exists, skip this article.
      if (fs.existsSync(filePath)) {
        console.log(`File already exists: ${filePath}. Skipping article ${article.id}.`)
        continue
      }
      
      // Process cover image if a cover URL is provided and starts with 'http'
      if (articleData.cover && articleData.cover.startsWith('http')) {
        // Determine a filename for the cover image.
        const filename = `${slugValue}-cover.jpg`
        const localImagePath = path.join(imagesDir, filename)
        // Only download the image if it doesn't already exist.
        if (!fs.existsSync(localImagePath)) {
          await downloadImage(articleData.cover, filename)
          console.log(`Downloaded cover image to ${localImagePath}`)
        } else {
          console.log(`Cover image already exists: ${localImagePath}`)
        }
        // Update frontmatter.cover to the local file path relative to the site.
        // Adjust this if your site expects a different relative path.
        frontmatter.cover = path.join('covers', filename)
      }
      
      // Convert frontmatter object to YAML string.
      const yamlFrontmatter = yaml.dump(frontmatter)
      // Assume that article.articleData.content holds the article body in Markdown.
      const content = `---\n${yamlFrontmatter}---\n\n${article.articleData.content || ''}`
      
      fs.writeFileSync(filePath, content)
      console.log(`Wrote article ${article.id} to ${filePath}`)
    }
  } catch (error) {
    console.error('Error fetching or writing articles:', error)
  }
}

main()
