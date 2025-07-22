const axios = require('axios');
const pdf = require('pdf-parse');
const stringSimilarity = require('string-similarity');


async function readPdfFromUrl(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer'
    });
    
    const buffer = Buffer.from(response.data);
    const data = await pdf(buffer);
    
    return {
      text: data.text,
      pages: data.numpages,
      info: data.info,
      metadata: data.metadata
    };
  } catch (error) {
    throw new Error(`Failed to read PDF: ${error.message}`);
  }
}
module.exports = {readPdfFromUrl}