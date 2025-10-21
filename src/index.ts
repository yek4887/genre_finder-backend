// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// 💡 Spotify API의 Track 타입을 사용하기 위해 import 경로를 찾습니다.
// 이 타입은 라이브러리 자체에 내장되어 있습니다.
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';


const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

const refreshSpotifyToken = async () => {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    console.log('Spotify access token refreshed!');
  } catch (err) {
    console.error('Could not refresh Spotify access token', err);
  }
};

app.post('/api/recommend-genres', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const artistSearch = await spotifyApi.searchArtists(query, { limit: 1 });
    if (!artistSearch.body.artists || artistSearch.body.artists.items.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }
    const artist = artistSearch.body.artists.items[0];
    const topTracksResponse = await spotifyApi.getArtistTopTracks(artist.id, 'US');
    const topTracks = topTracksResponse.body.tracks.slice(0, 5);

    const prompt = `
      You are a world-class music curator. A user is searching for an artist named "${artist.name}".
      Their top tracks are: ${topTracks.map(t => t.name).join(', ')}.
      Based on this artist's style, recommend 3 unique and interesting music genres.
      For each genre, provide a short, engaging description and 3 other representative artists.
      Do not recommend the genre "${artist.genres.join(', ')}" or the artist "${artist.name}".
      Provide the response strictly in JSON format like this:
      {
        "genres": [
          {"name": "Genre Name", "description": "Genre description.", "artists": ["Artist A", "Artist B", "Artist C"]},
          ...
        ]
      }
    `;
    
    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: "json_object" },
    });

    const aiGenres = JSON.parse(aiResponse.choices[0].message.content || '{}');

    const responseData = {
      searchedArtist: {
        name: artist.name,
        imageUrl: artist.images[0]?.url,
        // ⭐ 바로 이 부분입니다! track에 타입을 명시해줬습니다.
        topTracks: topTracks.map((track: TrackObjectFull) => ({
          title: track.name,
          album: track.album.name,
        })),
      },
      aiRecommendations: aiGenres.genres,
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  refreshSpotifyToken();
  setInterval(refreshSpotifyToken, 1000 * 60 * 55);
});