import { expect } from 'chai';
import { EJSON, ObjectId, Binary, Long, Decimal128, Double, Int32 } from '../register-bson';

describe('EJSON stringifyStream', function () {
  async function collectStream(generator: AsyncGenerator<string, void, unknown>): Promise<string> {
    let result = '';
    for await (const chunk of generator) {
      result += chunk;
    }
    return result;
  }

  it('should stream stringify a simple object', async function () {
    const obj = { a: 1, b: 'hello', c: true };
    const streamed = await collectStream(EJSON.stringifyStream(obj));
    const regular = EJSON.stringify(obj);
    expect(streamed).to.equal(regular);
  });

  it('should stream stringify with BSON types', async function () {
    const obj = {
      oid: new ObjectId(),
      binary: new Binary(Buffer.from('hello')),
      long: Long.fromNumber(42),
      decimal: new Decimal128('123.45'),
      double: new Double(3.14),
      int32: new Int32(42)
    };
    const streamed = await collectStream(EJSON.stringifyStream(obj));
    const regular = EJSON.stringify(obj);
    expect(streamed).to.equal(regular);
  });

  it('should stream stringify with relaxed mode', async function () {
    const obj = {
      int: 42,
      double: 3.14,
      date: new Date('2023-01-01')
    };
    const streamed = await collectStream(EJSON.stringifyStream(obj, { relaxed: true }));
    const regular = EJSON.stringify(obj, { relaxed: true });
    expect(streamed).to.equal(regular);
  });

  it('should stream stringify with legacy mode', async function () {
    const obj = {
      int: 42,
      double: 3.14,
      date: new Date('2023-01-01')
    };
    const streamed = await collectStream(EJSON.stringifyStream(obj, { legacy: true }));
    const regular = EJSON.stringify(obj, { legacy: true });
    expect(streamed).to.equal(regular);
  });

  it('should stream stringify with indentation', async function () {
    const obj = { a: { b: { c: 1 } }, d: [1, 2, 3] };
    const streamed = await collectStream(EJSON.stringifyStream(obj, null, 2));
    const regular = EJSON.stringify(obj, null, 2);
    expect(streamed).to.equal(regular);
  });

  it('should stream stringify with custom indentation string', async function () {
    const obj = { a: { b: { c: 1 } }, d: [1, 2, 3] };
    const streamed = await collectStream(EJSON.stringifyStream(obj, null, '\t'));
    const regular = EJSON.stringify(obj, null, '\t');
    expect(streamed).to.equal(regular);
  });

  it('should handle replacer function', async function () {
    const obj = { a: 1, b: 2, c: 3 };
    const replacer = function (key: string, value: any) {
      if (key === 'b') return undefined;
      return value;
    };
    const streamed = await collectStream(EJSON.stringifyStream(obj, replacer));
    const regular = EJSON.stringify(obj, replacer);
    expect(streamed).to.equal(regular);
  });

  it('should handle replacer array', async function () {
    const obj = { a: 1, b: 2, c: 3 };
    const replacer = ['a', 'c'];
    const streamed = await collectStream(EJSON.stringifyStream(obj, replacer));
    const regular = EJSON.stringify(obj, replacer);
    expect(streamed).to.equal(regular);
  });

  it('should handle nested objects and arrays', async function () {
    const obj = {
      nested: {
        array: [1, 2, { deep: { value: 'test' } }],
        object: {
          a: 1,
          b: {
            c: [new ObjectId(), new Binary(Buffer.from('data'))]
          }
        }
      }
    };
    const streamed = await collectStream(EJSON.stringifyStream(obj));
    const regular = EJSON.stringify(obj);
    expect(streamed).to.equal(regular);
  });

  it('should detect circular references', async function () {
    const obj: any = { a: 1 };
    obj.circular = obj;

    try {
      await collectStream(EJSON.stringifyStream(obj));
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect(error.message).to.include('Converting circular structure');
    }
  });

  it('should handle very large arrays efficiently', async function () {
    // Create a large array that would be problematic for regular stringify
    const size = 100000;
    const largeArray = new Array(size);
    for (let i = 0; i < size; i++) {
      largeArray[i] = {
        index: i,
        oid: new ObjectId(),
        value: 'test-' + i
      };
    }

    const chunks: string[] = [];
    let chunkCount = 0;

    // Collect chunks to verify streaming behavior
    for await (const chunk of EJSON.stringifyStream({ data: largeArray })) {
      chunks.push(chunk);
      chunkCount++;
    }

    // Verify that it produced multiple chunks (streaming behavior)
    expect(chunkCount).to.be.greaterThan(1);

    // Verify the result is valid JSON
    const result = chunks.join('');
    const parsed = JSON.parse(result);
    expect(parsed.data).to.have.lengthOf(size);
  });

  it('should handle parameter variations correctly', async function () {
    const obj = { a: 1, b: 2 };

    // Test with space as options
    const streamed1 = await collectStream(EJSON.stringifyStream(obj, null, { relaxed: true }));
    const regular1 = EJSON.stringify(obj, null, { relaxed: true });
    expect(streamed1).to.equal(regular1);

    // Test with replacer as options
    const streamed2 = await collectStream(EJSON.stringifyStream(obj, { relaxed: false }));
    const regular2 = EJSON.stringify(obj, { relaxed: false });
    expect(streamed2).to.equal(regular2);
  });
});
