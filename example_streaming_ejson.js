const { EJSON, ObjectId } = require('./lib/bson');

async function demonstrateStreamingEJSON() {
  // Create a large document that would cause issues with regular stringify
  const largeDocument = {
    metadata: {
      created: new Date(),
      id: new ObjectId(),
      version: 1
    },
    data: []
  };

  // Add lots of data
  for (let i = 0; i < 1000000; i++) {
    largeDocument.data.push({
      index: i,
      id: new ObjectId(),
      timestamp: new Date(),
      value: `Item ${i}`,
      nested: {
        a: Math.random(),
        b: Math.random(),
        c: Math.random()
      }
    });
  }

  console.log('Streaming large EJSON document...');
  
  // Use streaming to handle the large document
  let totalSize = 0;
  let chunkCount = 0;
  
  for await (const chunk of EJSON.stringifyStream(largeDocument, null, 2)) {
    totalSize += chunk.length;
    chunkCount++;
    
    // In a real application, you might write each chunk to a file or stream
    // For demo purposes, we'll just count the chunks
    if (chunkCount % 1000 === 0) {
      console.log(`Processed ${chunkCount} chunks, total size: ${totalSize} bytes`);
    }
  }
  
  console.log(`\nStreaming complete!`);
  console.log(`Total chunks: ${chunkCount}`);
  console.log(`Total size: ${totalSize} bytes (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
}

// Run the demonstration
demonstrateStreamingEJSON().catch(console.error);